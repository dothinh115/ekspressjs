import { execSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import chalk from 'chalk';
import { DeployConfig } from './types';
import { generateDockerfile } from './templates/dockerfile';
import {
  generateDeploymentManifest,
  generateServiceManifest,
  generateIngressManifest,
  generateAutoscalingManifest,
  generateSecretsManifest,
} from './templates/kubernetes';
import { configureAWS, buildAndPushImage, setupKubectl, applyManifests, setupDomain, waitForIngressAndSetupDNS, checkAndInstallALBController, checkAndEnsureNodes, setupECRImagePullSecret, checkAndFixImagePullError, checkAndFixALBIAMPermissions } from './aws-utils';
import { checkPrerequisites, validateProjectStructure, createNextConfigIfNeeded } from './utils';
import { diagnoseDeploymentFailure } from './diagnose';
import axios from 'axios';

export async function deployToEKS(config: DeployConfig): Promise<void> {
  console.log(chalk.blue('\n📦 Starting deployment process...\n'));

  // All generated artifacts will be placed under ./ekspressjs
  const artifactsDir = path.join(process.cwd(), 'ekspressjs');
  await fs.ensureDir(artifactsDir);
  const manifestsDir = path.join(artifactsDir, 'k8s');
  config.artifactDir = artifactsDir;
  console.log(chalk.cyan(`🗂  Using artifacts directory: ${artifactsDir}`));

  validateProjectStructure(config.appType);
  if (config.appType === 'next') {
    await createNextConfigIfNeeded();
  }

  console.log(chalk.yellow('📝 Step 1: Generating Dockerfile...'));
  const dockerfile = generateDockerfile(config.appType, config.port);
  await fs.writeFile(path.join(artifactsDir, 'Dockerfile'), dockerfile);
  console.log(chalk.green('✅ Dockerfile generated'));

  console.log(chalk.yellow('\n📝 Step 2: Generating Kubernetes manifests...'));

  if (config.domain && config.domain.enableSSL) {
    console.log(chalk.blue('   Setting up domain and SSL certificate...'));
    const certificateARN = await setupDomain(config);
    if (certificateARN && !config.domain.certificateARN) {
      config.domain.certificateARN = certificateARN;
    }
  }

  const deploymentManifest = generateDeploymentManifest(config, config.appType);
  const serviceManifest = generateServiceManifest(config, config.appType);

  await fs.ensureDir(manifestsDir);

  await fs.writeFile(path.join(manifestsDir, 'deployment.yaml'), deploymentManifest);
  await fs.writeFile(path.join(manifestsDir, 'service.yaml'), serviceManifest);

  if (config.secrets && Object.keys(config.secrets).length > 0) {
    const secretsManifest = generateSecretsManifest(config);
    await fs.writeFile(path.join(manifestsDir, 'secrets.yaml'), secretsManifest);
    console.log(chalk.green('✅ Secrets manifest generated'));
  }

  if (config.autoscaling && config.autoscaling.enabled) {
    const hpaManifest = generateAutoscalingManifest(config);
    await fs.writeFile(path.join(manifestsDir, 'hpa.yaml'), hpaManifest);
    console.log(chalk.green('✅ Autoscaling manifest generated'));
  }

  if (config.enableIngress) {
    const ingressManifest = generateIngressManifest(config);
    await fs.writeFile(path.join(manifestsDir, 'ingress.yaml'), ingressManifest);
    console.log(chalk.green('✅ Ingress manifest generated'));
  }

  console.log(chalk.green('✅ Kubernetes manifests generated'));

  console.log(chalk.yellow('\n🔐 Step 3: Configuring AWS credentials...'));
  await configureAWS(config);
  console.log(chalk.green('✅ AWS credentials configured'));

  console.log(chalk.yellow('\n⚙️  Step 4: Setting up kubectl...'));
  await setupKubectl(config);
  console.log(chalk.green('✅ kubectl configured'));

  console.log(chalk.yellow('\n🔍 Step 4.1: Checking cluster nodes...'));
  await checkAndEnsureNodes(config);
  console.log(chalk.green('✅ Cluster nodes ready'));

  if (config.enableIngress) {
    console.log(chalk.yellow('\n🔧 Step 4.5: Checking ALB Controller...'));
    await checkAndInstallALBController(config);
    console.log(chalk.green('✅ ALB Controller ready'));
    
    // Check for IAM permission issues after a delay
    console.log(chalk.blue('   Verifying ALB Controller IAM permissions...'));
    await new Promise(resolve => setTimeout(resolve, 5000));
    await checkAndFixALBIAMPermissions(config);
  }

  console.log(chalk.yellow('\n🐳 Step 5: Building and pushing Docker image...'));
  const imageUri = await buildAndPushImage(config);
  console.log(chalk.green(`✅ Image built and pushed: ${imageUri}`));

  if (imageUri) {
    const updatedDeployment = deploymentManifest.replace(
      /image: .*/,
      `image: ${imageUri}`
    );
    await fs.writeFile(path.join(manifestsDir, 'deployment.yaml'), updatedDeployment);
  }

  // Setup ECR ImagePullSecret if using ECR
  if (config.imageRegistry && config.imageRegistry.includes('amazonaws.com')) {
    console.log(chalk.yellow('\n🔐 Step 5.5: Setting up ECR ImagePullSecret...'));
    await setupECRImagePullSecret(config);
    console.log(chalk.green('✅ ECR ImagePullSecret configured'));
  }

  console.log(chalk.yellow('\n☸️  Step 6: Deploying to EKS cluster...'));
  await applyManifests(config, manifestsDir);
  console.log(chalk.green('✅ Deployment applied to cluster'));

  console.log(chalk.yellow('\n⏳ Step 7: Waiting for deployment to be ready...'));
  try {
    execSync(
      `kubectl rollout status deployment/${config.appName} -n ${config.namespace || 'default'} --timeout=300s`,
      { stdio: 'inherit' }
    );
    console.log(chalk.green('✅ Deployment is ready!'));
  } catch (error: any) {
    console.log(chalk.yellow('\n⚠️  Deployment not ready yet. Checking for image pull errors...'));
    
    // Check and try to fix ImagePullBackOff errors
    await checkAndFixImagePullError(config);
    
    // Wait a bit and check again
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    try {
      execSync(
        `kubectl rollout status deployment/${config.appName} -n ${config.namespace || 'default'} --timeout=120s`,
        { stdio: 'inherit' }
      );
      console.log(chalk.green('✅ Deployment is ready after fix!'));
    } catch (retryError: any) {
      console.log(chalk.red('\n❌ Deployment failed or timed out. Running diagnostics...'));
      await diagnoseDeploymentFailure(config);
      throw retryError;
    }
  }

  let albDNS: string | null = null;
  if (config.domain && config.enableIngress) {
    try {
      albDNS = await waitForIngressAndSetupDNS(config);
    } catch (error) {
      console.log(chalk.yellow('⚠️  Could not setup DNS automatically'));
    }
  }

  console.log(chalk.yellow('\n📊 Step 8: Getting service information...'));
  try {
    const serviceInfo = execSync(
      `kubectl get service ${config.appName}-service -n ${config.namespace || 'default'} -o json`,
      { encoding: 'utf-8' }
    );
    const service = JSON.parse(serviceInfo);
    console.log(chalk.cyan('\n📋 Service Details:'));
    console.log(chalk.white(`   Name: ${service.metadata.name}`));
    console.log(chalk.white(`   Namespace: ${service.metadata.namespace}`));
    console.log(chalk.white(`   Type: ${service.spec.type}`));

    if (config.enableIngress) {
      try {
        const ingressInfo = execSync(
          `kubectl get ingress ${config.appName}-ingress -n ${config.namespace || 'default'} -o json`,
          { encoding: 'utf-8' }
        );
        const ingress = JSON.parse(ingressInfo);
        albDNS = ingress.status?.loadBalancer?.ingress?.[0]?.hostname || null;

        console.log(chalk.cyan('\n🌐 Ingress:'));
        if (config.domain) {
          const hostname = config.domain.subdomain
            ? `${config.domain.subdomain}.${config.domain.domain}`
            : config.domain.domain;
          console.log(chalk.white(`   Domain: ${hostname}`));
          if (albDNS) {
            console.log(chalk.white(`   ALB DNS: ${albDNS}`));
          }
        } else {
          console.log(chalk.white(`   Host: ${config.appName}.example.com`));
          if (albDNS) {
            console.log(chalk.white(`   ALB DNS: ${albDNS}`));
            console.log(chalk.yellow('\n   ⚠️  Manual DNS Configuration Required:'));
            console.log(chalk.cyan('   To access your app via custom domain:'));
            console.log(chalk.white('   1. Go to your DNS provider (Cloudflare, Route53, etc.)'));
            console.log(chalk.white('   2. Create a CNAME record:'));
            console.log(chalk.white(`      Name: your-subdomain (or @ for root domain)`));
            console.log(chalk.white(`      Value: ${albDNS}`));
            console.log(chalk.white('   3. If using SSL, ensure your ALB has SSL certificate attached'));
            console.log(chalk.white(`   4. Your app will be accessible at: https://your-domain.com`));
            console.log(chalk.gray(`\n   Current ALB endpoint: http://${albDNS}`));
          } else {
            console.log(chalk.yellow('   ⚠️  ALB is still being provisioned. Check again later.'));
          }
        }
      } catch (error) {
        console.log(chalk.yellow('⚠️  Could not retrieve ingress information'));
      }
    }
  } catch (error) {
    console.log(chalk.yellow('⚠️  Could not retrieve service information'));
  }

  console.log(chalk.green.bold('\n🎉 Deployment completed successfully!'));

  if (config.enableIngress && albDNS) {
    const healthPath = config.healthCheckPath || '/';
    
    // Check if HTTPS listener exists in ingress
    let protocol = 'http';
    let hasHTTPS = false;
    try {
      const ingressInfo = execSync(
        `kubectl get ingress ${config.appName}-ingress -n ${config.namespace || 'default'} -o jsonpath='{.metadata.annotations.alb\\.ingress\\.kubernetes\\.io/listen-ports}'`,
        { encoding: 'utf-8', stdio: 'pipe' }
      );
      if (ingressInfo && ingressInfo.includes('HTTPS')) {
        hasHTTPS = true;
        protocol = config.domain?.enableSSL ? 'https' : 'http';
      }
    } catch (error) {
      // If can't check, use default based on enableSSL
      protocol = config.domain?.enableSSL ? 'https' : 'http';
    }

    if (config.domain) {
      const hostname = config.domain.subdomain
        ? `${config.domain.subdomain}.${config.domain.domain}`
        : config.domain.domain;

      // Always show HTTP URL if HTTPS is not available
      const displayProtocol = hasHTTPS && config.domain?.enableSSL ? 'https' : 'http';
      console.log(chalk.cyan.bold(`\n🌍 Your application is live at: ${displayProtocol}://${hostname}`));
      if (config.domain?.enableSSL && !hasHTTPS) {
        console.log(chalk.yellow('   ⚠️  HTTPS not available (certificate not validated). Using HTTP.'));
      }
      console.log(chalk.gray(`   DNS is configured and pointing to ALB: ${albDNS}`));

      console.log(chalk.blue('\n🔍 Checking application health...'));
      await checkAppHealth(`${protocol}://${hostname}${healthPath}`, 20);
    } else {
      console.log(chalk.cyan.bold(`\n🌍 Your application is accessible via ALB: ${protocol}://${albDNS}`));
      console.log(chalk.yellow('   ⚠️  No custom domain configured. Using ALB DNS directly.'));

      console.log(chalk.blue('\n🔍 Checking application health...'));
      await checkAppHealth(`${protocol}://${albDNS}${healthPath}`, 20);
    }
  } else if (config.enableIngress && !albDNS) {
    if (config.domain) {
      const hostname = config.domain.subdomain
        ? `${config.domain.subdomain}.${config.domain.domain}`
        : config.domain.domain;
      console.log(chalk.yellow(`\n⏳ Domain configured: ${hostname}`));
      console.log(chalk.yellow(`   ALB is still being provisioned. Please wait 5-10 minutes.`));
      console.log(chalk.cyan(`   Check status: kubectl get ingress ${config.appName}-ingress -n ${config.namespace || 'default'}`));
      console.log(chalk.cyan(`   Once ALB DNS appears, DNS will be automatically configured.`));
    }
  } else {
    console.log(chalk.cyan('\n📋 Service Information:'));
    console.log(chalk.white(`   Service: ${config.appName}-service`));
    console.log(chalk.white(`   Namespace: ${config.namespace || 'default'}`));
    console.log(chalk.yellow('   ⚠️  Ingress not enabled. Access via port-forward:'));
    console.log(chalk.cyan(`   kubectl port-forward svc/${config.appName}-service ${config.port}:${config.port} -n ${config.namespace || 'default'}`));
  }
}

async function checkAppHealth(url: string, maxRetries: number = 10): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.get(url, {
        timeout: 5000,
        validateStatus: () => true,
      });

      if (response.status >= 200 && response.status < 400) {
        console.log(chalk.green(`   ✓ Application is responding (HTTP ${response.status})`));
        console.log(chalk.gray(`   URL: ${url}`));
        return;
      } else {
        console.log(chalk.yellow(`   ⚠️  Application returned HTTP ${response.status}`));
      }
    } catch (error: any) {
      if (i < maxRetries - 1) {
        if (i % 2 === 0) {
          console.log(chalk.yellow(`   Still checking... (attempt ${i + 1}/${maxRetries})`));
        }
        await new Promise(resolve => setTimeout(resolve, 10000));
      } else {
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
          console.log(chalk.yellow(`   ⚠️  Could not reach application (may still be starting)`));
          console.log(chalk.cyan(`   URL: ${url}`));
          console.log(chalk.cyan(`   This is normal if ALB was just created. Wait a few minutes and try again.`));
        } else {
          console.log(chalk.yellow(`   ⚠️  Health check failed: ${error.message}`));
        }
      }
    }
  }
}
