import inquirer from 'inquirer';
import chalk from 'chalk';
import { execSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { DomainConfig, Resources, Autoscaling, EnvVar } from './types';
import { checkClusterExists, listClusters } from './aws-utils';
import { detectAWSCredentials } from './utils';

export interface AWSConfig {
  region: string;
  clusterName: string;
  appName: string;
  port: number;
  replicas: number;
  accessKeyId: string;
  secretAccessKey: string;
  imageRegistry?: string;
  namespace?: string;
  enableIngress?: boolean;
  domain?: DomainConfig;
  resources?: Resources;
  autoscaling?: Autoscaling;
  envVars?: EnvVar[];
  secrets?: Record<string, string>;
  configMaps?: Record<string, string>;
  healthCheckPath?: string;
  enableMetrics?: boolean;
}

const CONFIG_FILE_NAME = '.ekspressjs-config.json';

function getConfigFilePath(): string {
  return path.join(process.cwd(), CONFIG_FILE_NAME);
}

export function loadSavedConfig(): Partial<AWSConfig> | null {
  try {
    const configPath = getConfigFilePath();
    if (fs.existsSync(configPath)) {
      const config = fs.readJsonSync(configPath);
      return config;
    }
  } catch (error) {
  }
  return null;
}

function saveConfig(config: AWSConfig): void {
  try {
    const configPath = getConfigFilePath();
    const configToSave: Partial<AWSConfig> = {
      region: config.region,
      clusterName: config.clusterName,
      appName: config.appName,
      port: config.port,
      replicas: config.replicas,
      accessKeyId: config.accessKeyId,
      imageRegistry: config.imageRegistry,
      namespace: config.namespace,
      enableIngress: config.enableIngress,
      domain: config.domain,
      resources: config.resources,
      autoscaling: config.autoscaling,
      envVars: config.envVars,
      secrets: config.secrets,
      configMaps: config.configMaps,
      healthCheckPath: config.healthCheckPath,
      enableMetrics: config.enableMetrics,
    };
    fs.writeJsonSync(configPath, configToSave, { spaces: 2 });
  } catch (error) {
  }
}

function validateSavedConfig(config: Partial<AWSConfig>): boolean {
  return !!(
    config.region &&
    config.clusterName &&
    config.appName &&
    config.accessKeyId &&
    config.port !== undefined &&
    config.replicas !== undefined
  );
}

export async function promptAWSConfig(options: any): Promise<AWSConfig> {
  const savedConfig = loadSavedConfig();
  const isInteractive = process.stdin.isTTY;

  if (savedConfig && validateSavedConfig(savedConfig)) {
    console.log(chalk.green('✓ Found saved configuration in .ekspressjs-config.json\n'));

    let useSaved = true;
    
    if (isInteractive) {
      const useSavedAnswer = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'useSaved',
          message: 'Use saved configuration? (Skip prompts and deploy immediately)',
          default: true,
        },
      ]);
      useSaved = useSavedAnswer.useSaved;
    } else {
      console.log(chalk.cyan('   Non-interactive mode: Using saved configuration automatically\n'));
    }

    if (useSaved) {
      console.log(chalk.cyan('\n📋 Using saved configuration...\n'));

      const detectedCreds = detectAWSCredentials();
      let secretAccessKey = '';

      if (detectedCreds && detectedCreds.secretAccessKey) {
        if (isInteractive) {
          const useDetected = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'useDetected',
              message: `Use detected AWS Secret Access Key from AWS CLI?`,
              default: true,
            },
          ]);

          if (useDetected.useDetected) {
            secretAccessKey = detectedCreds.secretAccessKey;
          } else {
            const secretAnswer = await inquirer.prompt([
              {
                type: 'password',
                name: 'secretAccessKey',
                message: 'AWS Secret Access Key:',
                mask: '*',
                validate: (input: string) => input.length > 0 || 'Secret Access Key is required',
              },
            ]);
            secretAccessKey = secretAnswer.secretAccessKey;
          }
        } else {
          // Non-interactive: auto-use detected credentials
          secretAccessKey = detectedCreds.secretAccessKey;
          console.log(chalk.green('   ✓ Using AWS Secret Access Key from AWS CLI\n'));
        }
      } else {
        if (isInteractive) {
          const secretAnswer = await inquirer.prompt([
            {
              type: 'password',
              name: 'secretAccessKey',
              message: 'AWS Secret Access Key (not saved in config file):',
              mask: '*',
              validate: (input: string) => input.length > 0 || 'Secret Access Key is required',
            },
          ]);
          secretAccessKey = secretAnswer.secretAccessKey;
        } else {
          throw new Error('AWS Secret Access Key not found. Please configure AWS CLI or provide credentials.');
        }
      }

      const config: AWSConfig = {
        region: savedConfig.region!,
        clusterName: savedConfig.clusterName!,
        appName: options.name || savedConfig.appName!,
        port: options.port ? parseInt(options.port) : savedConfig.port!,
        replicas: options.replicas ? parseInt(options.replicas) : savedConfig.replicas!,
        accessKeyId: savedConfig.accessKeyId!,
        secretAccessKey: secretAccessKey,
        imageRegistry: savedConfig.imageRegistry,
        namespace: savedConfig.namespace || 'default',
        enableIngress: savedConfig.enableIngress !== undefined ? savedConfig.enableIngress : true,
        domain: savedConfig.domain,
        resources: savedConfig.resources,
        autoscaling: savedConfig.autoscaling,
        envVars: savedConfig.envVars,
        secrets: savedConfig.secrets,
        configMaps: savedConfig.configMaps,
        healthCheckPath: savedConfig.healthCheckPath || '/',
        enableMetrics: savedConfig.enableMetrics || false,
      };

      console.log(chalk.green('✓ Configuration loaded from file\n'));
      return config;
    }
  }

  console.log(chalk.cyan('📋 Basic Configuration:\n'));

  const detectedCreds = detectAWSCredentials();
  let accessKeyAnswer: { accessKeyId: string; secretAccessKey: string };
  let regionAnswer: { region: string };

  if (detectedCreds && detectedCreds.accessKeyId && detectedCreds.secretAccessKey) {
    console.log(chalk.green('✓ AWS credentials detected from AWS CLI configuration\n'));

    const useDetected = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useDetected',
        message: `Use detected AWS credentials? (Access Key: ${detectedCreds.accessKeyId.substring(0, 8)}...)`,
        default: true,
      },
    ]);

    if (useDetected.useDetected) {
      accessKeyAnswer = {
        accessKeyId: detectedCreds.accessKeyId,
        secretAccessKey: detectedCreds.secretAccessKey,
      };

      regionAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'region',
          message: 'AWS Region:',
          default: detectedCreds.region || savedConfig?.region || 'us-east-1',
          validate: (input: string) => input.length > 0 || 'Region is required',
        },
      ]);
    } else {
      accessKeyAnswer = await inquirer.prompt([
        {
          type: 'password',
          name: 'accessKeyId',
          message: 'AWS Access Key ID:',
          mask: '*',
          validate: (input: string) => input.length > 0 || 'Access Key ID is required',
        },
        {
          type: 'password',
          name: 'secretAccessKey',
          message: 'AWS Secret Access Key:',
          mask: '*',
          validate: (input: string) => input.length > 0 || 'Secret Access Key is required',
        },
      ]);

      regionAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'region',
          message: 'AWS Region:',
          default: savedConfig?.region || 'us-east-1',
          validate: (input: string) => input.length > 0 || 'Region is required',
        },
      ]);
    }
  } else {
    console.log(chalk.yellow('⚠️  No AWS credentials detected. Please configure AWS CLI or enter credentials manually.\n'));
    console.log(chalk.cyan('   To configure AWS CLI, run: aws configure\n'));

    accessKeyAnswer = await inquirer.prompt([
      {
        type: 'password',
        name: 'accessKeyId',
        message: 'AWS Access Key ID:',
        default: savedConfig?.accessKeyId || '',
        mask: '*',
        validate: (input: string) => input.length > 0 || 'Access Key ID is required',
      },
      {
        type: 'password',
        name: 'secretAccessKey',
        message: 'AWS Secret Access Key:',
        mask: '*',
        validate: (input: string) => input.length > 0 || 'Secret Access Key is required',
      },
    ]);

    regionAnswer = await inquirer.prompt([
      {
        type: 'input',
        name: 'region',
        message: 'AWS Region:',
        default: savedConfig?.region || 'us-east-1',
        validate: (input: string) => input.length > 0 || 'Region is required',
      },
    ]);
  }

  process.env.AWS_ACCESS_KEY_ID = accessKeyAnswer.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = accessKeyAnswer.secretAccessKey;
  process.env.AWS_DEFAULT_REGION = regionAnswer.region;
  process.env.AWS_REGION = regionAnswer.region;

  const tempConfig: any = {
    region: regionAnswer.region,
    accessKeyId: accessKeyAnswer.accessKeyId,
    secretAccessKey: accessKeyAnswer.secretAccessKey,
    clusterName: '',
  };

  const clusters = await listClusters(tempConfig);

  let clusterName = '';
  if (clusters.length > 0) {
    const clusterAnswer = await inquirer.prompt([
      {
        type: 'list',
        name: 'clusterChoice',
        message: 'Select EKS Cluster:',
        choices: [
          ...clusters.map(c => ({ name: c, value: c })),
          { name: 'Create new cluster', value: '__create__' },
          { name: 'Enter cluster name manually', value: '__manual__' },
        ],
      },
    ]);

    if (clusterAnswer.clusterChoice === '__create__') {
      const createAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'newClusterName',
          message: 'New Cluster Name:',
          default: savedConfig?.clusterName || 'my-eks-cluster',
          validate: (input: string) => input.length > 0 || 'Cluster name is required',
        },
        {
          type: 'input',
          name: 'nodeType',
          message: 'Node instance type:',
          default: 't3.small',
        },
        {
          type: 'input',
          name: 'nodeCount',
          message: 'Number of nodes:',
          default: '1',
          validate: (input: string) => {
            const val = parseInt(input);
            return (!isNaN(val) && val > 0) || 'Invalid node count';
          },
        },
        {
          type: 'confirm',
          name: 'confirmCreate',
          message: 'This will create a new EKS cluster (takes 10-15 minutes). Continue?',
          default: false,
        },
      ]);

      if (!createAnswer.confirmCreate) {
        console.log(chalk.yellow('Cluster creation cancelled. Exiting.'));
        process.exit(0);
      }

      clusterName = createAnswer.newClusterName;
      console.log(chalk.blue(`\n🚀 Creating EKS cluster '${clusterName}'...`));
      console.log(chalk.yellow('This will take 10-15 minutes. Please wait...\n'));

      try {
        execSync(`eksctl create cluster --name ${clusterName} --region ${regionAnswer.region} --with-oidc --managed --node-type ${createAnswer.nodeType} --nodes ${createAnswer.nodeCount}`, {
          stdio: 'inherit',
          env: { ...process.env },
        });
        console.log(chalk.green(`\n✓ Cluster '${clusterName}' created successfully!`));
      } catch (error: any) {
        console.log(chalk.red(`\n✗ Failed to create cluster: ${error.message}`));
        console.log(chalk.yellow('Please ensure eksctl is installed: brew install eksctl'));
        throw error;
      }
    } else if (clusterAnswer.clusterChoice === '__manual__') {
      const manualAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'clusterName',
          message: 'EKS Cluster Name:',
          default: savedConfig?.clusterName || '',
          validate: (input: string) => input.length > 0 || 'Cluster name is required',
        },
      ]);
      clusterName = manualAnswer.clusterName;
    } else {
      clusterName = clusterAnswer.clusterChoice;
    }
  } else {
    const noClusterAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'createCluster',
        message: 'No EKS clusters found. Create a new cluster?',
        default: true,
      },
    ]);

    if (noClusterAnswer.createCluster) {
      const createAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'newClusterName',
          message: 'New Cluster Name:',
          default: savedConfig?.clusterName || 'my-eks-cluster',
          validate: (input: string) => input.length > 0 || 'Cluster name is required',
        },
        {
          type: 'input',
          name: 'nodeType',
          message: 'Node instance type:',
          default: 't3.small',
        },
        {
          type: 'input',
          name: 'nodeCount',
          message: 'Number of nodes:',
          default: '1',
          validate: (input: string) => {
            const val = parseInt(input);
            return (!isNaN(val) && val > 0) || 'Invalid node count';
          },
        },
      ]);

      clusterName = createAnswer.newClusterName;
      console.log(chalk.blue(`\n🚀 Creating EKS cluster '${clusterName}'...`));
      console.log(chalk.yellow('This will take 10-15 minutes. Please wait...\n'));

      try {
        execSync(`eksctl create cluster --name ${clusterName} --region ${regionAnswer.region} --with-oidc --managed --node-type ${createAnswer.nodeType} --nodes ${createAnswer.nodeCount}`, {
          stdio: 'inherit',
          env: { ...process.env },
        });
        console.log(chalk.green(`\n✓ Cluster '${clusterName}' created successfully!`));
      } catch (error: any) {
        console.log(chalk.red(`\n✗ Failed to create cluster: ${error.message}`));
        console.log(chalk.yellow('Please ensure eksctl is installed: brew install eksctl'));
        throw error;
      }
    } else {
      const manualAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'clusterName',
          message: 'EKS Cluster Name:',
          default: savedConfig?.clusterName || '',
          validate: (input: string) => input.length > 0 || 'Cluster name is required',
        },
      ]);
      clusterName = manualAnswer.clusterName;
    }
  }

  console.log(chalk.cyan('\n📦 Application Configuration:\n'));
  console.log(chalk.gray('   App Name: Unique identifier for this app (e.g., "frontend", "backend-api")'));
  console.log(chalk.gray('   Namespace: Groups apps in the cluster (e.g., "production", "frontend", "backend")\n'));

  const appAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'appName',
      message: 'Application Name (unique identifier for this app):',
      default: options.name || savedConfig?.appName || 'my-app',
      validate: (input: string) => {
        if (!input.match(/^[a-z0-9-]+$/)) {
          return 'App name must contain only lowercase letters, numbers, and hyphens';
        }
        return true;
      },
    },
    {
      type: 'input',
      name: 'port',
      message: 'Application Port:',
      default: options.port || (savedConfig?.port ? String(savedConfig.port) : '3000'),
      validate: (input: string) => {
        const port = parseInt(input);
        return (!isNaN(port) && port > 0 && port < 65536) || 'Invalid port number';
      },
    },
    {
      type: 'input',
      name: 'replicas',
      message: 'Number of Replicas:',
      default: options.replicas || (savedConfig?.replicas ? String(savedConfig.replicas) : '2'),
      validate: (input: string) => {
        const replicas = parseInt(input);
        return (!isNaN(replicas) && replicas > 0) || 'Invalid replica count';
      },
    },
    {
      type: 'input',
      name: 'namespace',
      message: 'Kubernetes Namespace (groups apps in cluster, use same for related apps):',
      default: savedConfig?.namespace || 'default',
    },
    {
      type: 'confirm',
      name: 'enableIngress',
      message: 'Enable Ingress (for external access)?',
      default: savedConfig?.enableIngress !== undefined ? savedConfig.enableIngress : true,
    },
    {
      type: 'input',
      name: 'imageRegistry',
      message: 'Docker Image Registry (ECR URI or Docker Hub username):',
      default: savedConfig?.imageRegistry || '',
    },
  ]);

  let imageRegistry = appAnswers.imageRegistry?.trim();

  if (!imageRegistry) {
    const confirmLocal = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useLocalImage',
        message: 'No image registry specified. Continue with local image only? (Pods may fail to pull if cluster cannot access your local image)',
        default: false,
      },
    ]);

    if (!confirmLocal.useLocalImage) {
      const registryAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'imageRegistry',
          message: 'Docker Image Registry (ECR URI or Docker Hub username):',
          validate: (input: string) => input.length > 0 || 'Registry is required unless you confirm using local image',
        },
      ]);
      imageRegistry = registryAnswer.imageRegistry.trim();
    }
  }

  const basicAnswers = {
    ...regionAnswer,
    ...accessKeyAnswer,
    clusterName,
    ...appAnswers,
    imageRegistry: imageRegistry || '',
  };

  console.log(chalk.cyan('\n🌐 Domain Configuration (Cloudflare):\n'));

  const domainAnswers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'configureDomain',
      message: 'Configure custom domain with Cloudflare?',
      default: savedConfig?.domain ? true : false,
    },
    {
      type: 'input',
      name: 'domain',
      message: 'Domain name (e.g., example.com):',
      when: (answers: any) => answers.configureDomain,
      default: savedConfig?.domain?.domain || '',
      validate: (input: string, answers: any) => {
        if (answers.configureDomain && !input) {
          return 'Domain is required when domain configuration is enabled';
        }
        return true;
      },
    },
    {
      type: 'input',
      name: 'subdomain',
      message: 'Subdomain (leave empty for root domain):',
      when: (answers: any) => answers.configureDomain,
      default: savedConfig?.domain?.subdomain || '',
    },
    {
      type: 'confirm',
      name: 'enableSSL',
      message: 'Enable SSL/TLS?',
      when: (answers: any) => answers.configureDomain,
      default: savedConfig?.domain?.enableSSL !== undefined ? savedConfig.domain.enableSSL : true,
    },
    {
      type: 'input',
      name: 'certificateARN',
      message: 'ACM Certificate ARN (leave empty for auto-provision):',
      when: (answers: any) => answers.configureDomain && answers.enableSSL,
      default: '',
    },
    {
      type: 'password',
      name: 'cloudflareApiToken',
      message: 'Cloudflare API Token:',
      when: (answers: any) => answers.configureDomain,
      mask: '*',
      validate: (input: string, answers: any) => {
        if (answers.configureDomain && !input) {
          return 'Cloudflare API Token is required';
        }
        return true;
      },
    },
    {
      type: 'input',
      name: 'cloudflareZoneId',
      message: 'Cloudflare Zone ID:',
      when: (answers: any) => answers.configureDomain,
      validate: (input: string, answers: any) => {
        if (answers.configureDomain && !input) {
          return 'Cloudflare Zone ID is required';
        }
        return true;
      },
    },
  ]);

  console.log(chalk.cyan('\n⚙️  Advanced Configuration:\n'));

  const advancedAnswers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'configureResources',
      message: 'Configure custom resource limits?',
      default: false,
    },
    {
      type: 'input',
      name: 'cpuRequest',
      message: 'CPU Request (e.g., 250m):',
      when: (answers: any) => answers.configureResources,
      default: '250m',
    },
    {
      type: 'input',
      name: 'memoryRequest',
      message: 'Memory Request (e.g., 256Mi):',
      when: (answers: any) => answers.configureResources,
      default: '256Mi',
    },
    {
      type: 'input',
      name: 'cpuLimit',
      message: 'CPU Limit (e.g., 500m):',
      when: (answers: any) => answers.configureResources,
      default: '500m',
    },
    {
      type: 'input',
      name: 'memoryLimit',
      message: 'Memory Limit (e.g., 512Mi):',
      when: (answers: any) => answers.configureResources,
      default: '512Mi',
    },
    {
      type: 'confirm',
      name: 'enableAutoscaling',
      message: 'Enable Horizontal Pod Autoscaling?',
      default: false,
    },
    {
      type: 'input',
      name: 'minReplicas',
      message: 'Minimum Replicas:',
      when: (answers: any) => answers.enableAutoscaling,
      default: '2',
      validate: (input: string) => {
        const val = parseInt(input);
        return (!isNaN(val) && val > 0) || 'Invalid value';
      },
    },
    {
      type: 'input',
      name: 'maxReplicas',
      message: 'Maximum Replicas:',
      when: (answers: any) => answers.enableAutoscaling,
      default: '10',
      validate: (input: string) => {
        const val = parseInt(input);
        return (!isNaN(val) && val > 0) || 'Invalid value';
      },
    },
    {
      type: 'input',
      name: 'targetCPU',
      message: 'Target CPU Utilization (%):',
      when: (answers: any) => answers.enableAutoscaling,
      default: '70',
      validate: (input: string) => {
        const val = parseInt(input);
        return (!isNaN(val) && val > 0 && val <= 100) || 'Invalid percentage';
      },
    },
    {
      type: 'input',
      name: 'healthCheckPath',
      message: 'Health Check Path:',
      default: '/',
    },
    {
      type: 'confirm',
      name: 'addEnvVars',
      message: 'Add environment variables?',
      default: false,
    },
    {
      type: 'input',
      name: 'envVars',
      message: 'Environment variables (format: KEY1=value1,KEY2=value2):',
      when: (answers: any) => answers.addEnvVars,
      default: '',
    },
    {
      type: 'confirm',
      name: 'addSecrets',
      message: 'Add secrets?',
      default: false,
    },
    {
      type: 'input',
      name: 'secrets',
      message: 'Secrets (format: KEY1=secret1,KEY2=secret2):',
      when: (answers: any) => answers.addSecrets,
      default: '',
    },
    {
      type: 'confirm',
      name: 'enableMetrics',
      message: 'Enable metrics collection?',
      default: false,
    },
  ]);

  const config: AWSConfig = {
    region: basicAnswers.region,
    clusterName: basicAnswers.clusterName,
    appName: basicAnswers.appName,
    port: parseInt(basicAnswers.port),
    replicas: parseInt(basicAnswers.replicas),
    accessKeyId: basicAnswers.accessKeyId,
    secretAccessKey: basicAnswers.secretAccessKey,
    imageRegistry: basicAnswers.imageRegistry || undefined,
    namespace: basicAnswers.namespace || 'default',
    enableIngress: basicAnswers.enableIngress,
    healthCheckPath: advancedAnswers.healthCheckPath || '/',
    enableMetrics: advancedAnswers.enableMetrics,
  };

  if (domainAnswers.configureDomain) {
    config.domain = {
      domain: domainAnswers.domain,
      subdomain: domainAnswers.subdomain || undefined,
      enableSSL: domainAnswers.enableSSL,
      certificateARN: domainAnswers.certificateARN || undefined,
      cloudflareApiToken: domainAnswers.cloudflareApiToken,
      cloudflareZoneId: domainAnswers.cloudflareZoneId,
    };
  }

  if (advancedAnswers.configureResources) {
    config.resources = {
      requests: {
        cpu: advancedAnswers.cpuRequest,
        memory: advancedAnswers.memoryRequest,
      },
      limits: {
        cpu: advancedAnswers.cpuLimit,
        memory: advancedAnswers.memoryLimit,
      },
    };
  }

  if (advancedAnswers.enableAutoscaling) {
    config.autoscaling = {
      enabled: true,
      minReplicas: parseInt(advancedAnswers.minReplicas),
      maxReplicas: parseInt(advancedAnswers.maxReplicas),
      targetCPU: parseInt(advancedAnswers.targetCPU),
    };
  }

  if (advancedAnswers.addEnvVars && advancedAnswers.envVars) {
    const envVars: EnvVar[] = [];
    const pairs = advancedAnswers.envVars.split(',');
    for (const pair of pairs) {
      const [name, value] = pair.split('=').map((s: string) => s.trim());
      if (name && value) {
        envVars.push({ name, value });
      }
    }
    config.envVars = envVars.length > 0 ? envVars : undefined;
  }

  if (advancedAnswers.addSecrets && advancedAnswers.secrets) {
    const secrets: Record<string, string> = {};
    const pairs = advancedAnswers.secrets.split(',');
    for (const pair of pairs) {
      const [key, value] = pair.split('=').map((s: string) => s.trim());
      if (key && value) {
        secrets[key] = value;
      }
    }
    config.secrets = Object.keys(secrets).length > 0 ? secrets : undefined;
  }

  saveConfig(config);
  console.log(chalk.green('\n✓ Configuration saved to .ekspressjs-config.json\n'));

  return config;
}

