#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { execSync, spawn } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import axios from 'axios';
import { deployToEKS } from './deploy';
import { runDiagnostics } from './diagnose';
import { promptAWSConfig, loadSavedConfig } from './prompts';
import { checkPrerequisites } from './utils';
import { deleteCloudflareRecord } from './aws-utils';

const program = new Command();

program
  .name('ekspressjs')
  .description('Deploy applications to EKS quickly and easily')
  .version('1.0.0')
  .addHelpText('before', `
${chalk.blue.bold('🚀 EKSPressJS - EKS Deployment Tool')}

${chalk.cyan('Quick Start:')}
  npx ekspressjs --framework next
  npx ekspressjs --framework java --port 8080
  npx ekspressjs  # (requires Dockerfile in project root)

${chalk.cyan('Examples:')}
  # Deploy Next.js app
  npx ekspressjs --framework next --name my-app --port 3000

  # Deploy Java app with custom Dockerfile
  npx ekspressjs --framework java --port 8080 --name my-java-app

  # Deploy without specifying framework (auto-detect from Dockerfile)
  npx ekspressjs --port 8080 --name my-app

`)
  .option('-f, --framework <type>', 'Framework type: next, nuxt, nest, react, vue, java (optional if Dockerfile exists)')
  .option('-a, --app <type>', 'Framework type (deprecated, use --framework)')
  .option('-n, --name <name>', 'Application name')
  .option('-p, --port <port>', 'Application port', '3000')
  .option('-r, --replicas <count>', 'Number of replicas', '2')
  .addHelpText('after', `
${chalk.yellow('Note:')}
  - If --framework is not specified, the tool will check for a Dockerfile in the project root
  - If Dockerfile exists, it will use framework type 'java'
  - If no Dockerfile and no framework specified, deployment will fail

${chalk.cyan('For more information, visit:')} https://github.com/dothinh115/ekspressjs
`)
  .action(async (options) => {
    try {
      console.log(chalk.blue.bold('\n🚀 EKSPressJS - EKS Deployment Tool\n'));

      let frameworkType = options.framework || options.app;
      const validAppTypes = ['next', 'nuxt', 'nest', 'react', 'vue', 'java'];

      if (options.app && !options.framework) {
        console.log(chalk.yellow('⚠️  --app is deprecated, use --framework instead'));
      }

      // If no framework specified, check for Dockerfile
      if (!frameworkType) {
        const dockerfilePath = path.join(process.cwd(), 'Dockerfile');
        if (await fs.pathExists(dockerfilePath)) {
          console.log(chalk.cyan('   Found Dockerfile. Using framework type: java'));
          frameworkType = 'java';
        } else {
          console.error(chalk.red(`❌ Framework type is required or Dockerfile must exist`));
          console.log(chalk.yellow(`Valid frameworks: ${validAppTypes.join(', ')}`));
          console.log(chalk.cyan(`Example: npx ekspressjs --framework next`));
          console.log(chalk.cyan(`Or: npx ekspressjs (requires Dockerfile in project root)`));
          process.exit(1);
        }
      } else if (!validAppTypes.includes(frameworkType)) {
        console.error(chalk.red(`❌ Invalid framework type: ${frameworkType}`));
        console.log(chalk.yellow(`Valid frameworks: ${validAppTypes.join(', ')}`));
        console.log(chalk.cyan(`Example: npx ekspressjs --framework next`));
        process.exit(1);
      }

      console.log(chalk.cyan('\n🔍 Checking prerequisites...\n'));
      await checkPrerequisites();

      const awsConfig = await promptAWSConfig(options);

      await deployToEKS({
        appType: frameworkType,
        ...awsConfig,
        appName: options.name || awsConfig.appName,
        port: parseInt(options.port),
        replicas: parseInt(options.replicas),
      });

      console.log(chalk.green.bold('\n✅ Deployment completed successfully!\n'));
    } catch (error: any) {
      console.error(chalk.red.bold('\n❌ Deployment failed:'));
      console.error(chalk.red(error.message));
      if (error.stack) {
        console.error(chalk.gray(error.stack));
      }
      process.exit(1);
    }
  });

program
  .command('diagnose')
  .alias('doctor')
  .description('Check system health and debug stuck deployments')
  .option('-n, --name <name>', 'Application name')
  .action(async (options) => {
    try {
      await runDiagnostics(options);
    } catch (error: any) {
      console.error(chalk.red('\n❌ Diagnostics failed:'));
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });

program
  .command('delete')
  .description('Delete an existing deployment (and related service/ingress/HPA)')
  .option('-n, --namespace <ns>', 'Kubernetes namespace (optional, will prompt if not provided)')
  .action(async (options) => {
    try {
      console.log(chalk.blue.bold('\n🧹 EKSPressJS - Delete Deployment\n'));

      console.log(chalk.cyan('\n🔍 Checking prerequisites...\n'));
      await checkPrerequisites();

      // Step 1: Fetch all namespaces
      let namespaces: string[] = [];
      try {
        const output = execSync('kubectl get namespaces -o json', {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        const parsed = JSON.parse(output);
        namespaces =
          parsed.items?.map((ns: any) => ns.metadata?.name).filter(Boolean) || [];
      } catch (e: any) {
        console.log(chalk.red('❌ Could not list namespaces.'));
        if (e?.message) {
          console.log(chalk.yellow(`   Details: ${e.message}`));
        }
        console.log(
          chalk.yellow('   Check: kubectl context, AWS creds, and cluster accessibility.')
        );
        throw e;
      }

      if (namespaces.length === 0) {
        console.log(chalk.yellow('⚠️  No namespaces found.'));
        return;
      }

      // Step 2: Let user select namespace (or use provided one)
      let namespace = options.namespace;
      if (!namespace) {
        const nsAnswer = await inquirer.prompt([
          {
            type: 'list',
            name: 'namespace',
            message: 'Select namespace:',
            choices: [...namespaces, new inquirer.Separator(), 'Enter manually'],
          },
        ]);

        if (nsAnswer.namespace === 'Enter manually') {
          const manualNs = await inquirer.prompt([
            {
              type: 'input',
              name: 'namespace',
              message: 'Enter namespace name:',
              validate: (input: string) => {
                if (!input.trim()) {
                  return 'Namespace name cannot be empty';
                }
                return true;
              },
            },
          ]);
          namespace = manualNs.namespace.trim();
        } else {
          namespace = nsAnswer.namespace;
        }
      }

      // Step 3: Fetch deployments in selected namespace
      console.log(chalk.cyan(`\n📋 Fetching deployments in namespace '${namespace}'...`));

      let deployments: string[] = [];
      try {
        // Quick auth check to fail fast with clearer message
        try {
          execSync(`kubectl auth can-i list deployments -n ${namespace}`, {
            stdio: 'pipe',
          });
        } catch (authErr: any) {
          console.log(
            chalk.red('❌ kubectl is not authorized or kubeconfig is missing.')
          );
          console.log(
            chalk.yellow(
              '   - Ensure AWS credentials/kubeconfig are set (aws eks update-kubeconfig ...)'
            )
          );
          console.log(
            chalk.yellow(
              `   - Ensure you have permission to list deployments in namespace '${namespace}'.`
            )
          );
          throw authErr;
        }

        const output = execSync(
          `kubectl get deployments -n ${namespace} -o json`,
          { encoding: 'utf-8', stdio: 'pipe' }
        );
        const parsed = JSON.parse(output);
        deployments =
          parsed.items?.map((d: any) => d.metadata?.name).filter(Boolean) || [];
      } catch (e: any) {
        console.log(chalk.red('❌ Could not list deployments.'));
        if (e?.message) {
          console.log(chalk.yellow(`   Details: ${e.message}`));
        }
        console.log(
          chalk.yellow('   Check: kubectl context, AWS creds, and cluster accessibility.')
        );
        throw e;
      }

      if (deployments.length === 0) {
        console.log(
          chalk.yellow(`⚠️  No deployments found in namespace '${namespace}'.`)
        );
        return;
      }

      // Step 4: Let user select deployment to delete
      const answers = await inquirer.prompt([
        {
          type: 'list',
          name: 'deploy',
          message: 'Select deployment to delete:',
          choices: [...deployments, new inquirer.Separator(), 'Cancel'],
        },
        {
          type: 'confirm',
          name: 'confirm',
          message: (ans: any) =>
            `Delete deployment '${ans.deploy}' and related resources (service/ingress/HPA)?`,
          default: false,
          when: (ans: any) => ans.deploy !== 'Cancel',
        },
      ]);

      if (answers.deploy === 'Cancel' || !answers.confirm) {
        console.log(chalk.yellow('Cancelled.'));
        return;
      }

      const appName = answers.deploy;
      console.log(
        chalk.yellow(
          `\n🗑️  Deleting resources for '${appName}' in namespace '${namespace}'...\n`
        )
      );

      // Resources to delete
      const resources = [
        { type: 'deployment', name: appName },
        { type: 'service', name: `${appName}-service` },
        { type: 'ingress', name: `${appName}-ingress` },
        { type: 'hpa', name: `${appName}-hpa` },
      ];

      // Create a simple spinner
      const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let spinnerIndex = 0;
      let currentResource = '';
      let spinnerInterval: NodeJS.Timeout | null = null;

      const startSpinner = (resourceName: string) => {
        currentResource = resourceName;
        spinnerInterval = setInterval(() => {
          process.stdout.write(
            `\r${chalk.cyan(spinnerFrames[spinnerIndex])} ${chalk.gray(`Deleting ${currentResource}...`)}`
          );
          spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
        }, 100);
      };

      const stopSpinner = () => {
        if (spinnerInterval) {
          clearInterval(spinnerInterval);
          spinnerInterval = null;
        }
        process.stdout.write('\r' + ' '.repeat(80) + '\r'); // Clear line
      };

      try {
        for (const resource of resources) {
          startSpinner(`${resource.type} '${resource.name}'`);
          try {
            // Use spawn with timeout to avoid hanging
            const deletePromise = new Promise<void>((resolve, reject) => {
              const kubectl = spawn('kubectl', [
                'delete',
                resource.type,
                resource.name,
                '-n',
                namespace,
                '--ignore-not-found',
                '--grace-period=0',
                '--timeout=30s'
              ], {
                stdio: 'pipe',
              });

              let stdout = '';
              let stderr = '';

              kubectl.stdout?.on('data', (data) => {
                stdout += data.toString();
              });

              kubectl.stderr?.on('data', (data) => {
                stderr += data.toString();
              });

              kubectl.on('close', (code) => {
                if (code === 0 || stderr.includes('not found')) {
                  resolve();
                } else {
                  reject(new Error(stderr || `Exit code: ${code}`));
                }
              });

              kubectl.on('error', (error) => {
                reject(error);
              });

              // Timeout after 35 seconds
              setTimeout(() => {
                kubectl.kill();
                reject(new Error('Timeout: deletion took too long'));
              }, 35000);
            });

            await deletePromise;
            stopSpinner();
            console.log(chalk.green(`   ✓ ${resource.type} '${resource.name}' deleted`));
          } catch (error: any) {
            stopSpinner();
            // Check if it's a timeout or actual error
            if (error.message.includes('Timeout') || error.message.includes('timeout')) {
              console.log(chalk.yellow(`   ⚠ ${resource.type} '${resource.name}' - deletion timed out, checking status...`));
              // Try to check if it's actually deleted
              try {
                execSync(
                  `kubectl get ${resource.type} ${resource.name} -n ${namespace} 2>&1`,
                  { stdio: 'pipe', timeout: 5000 }
                );
                console.log(chalk.cyan(`   → ${resource.type} '${resource.name}' still exists, deletion may be in progress`));
                console.log(chalk.cyan(`   → You can check status: kubectl get ${resource.type} ${resource.name} -n ${namespace}`));
              } catch (e: any) {
                // Resource doesn't exist, deletion succeeded
                if (e.message.includes('not found') || e.stdout?.toString().includes('not found')) {
                  console.log(chalk.green(`   ✓ ${resource.type} '${resource.name}' deleted (verified)`));
                } else {
                  console.log(chalk.yellow(`   ⚠ Could not verify deletion status`));
                }
              }
            } else if (!error.message.includes('not found')) {
              console.log(chalk.yellow(`   ⚠ ${resource.type} '${resource.name}' - ${error.message}`));
            } else {
              // Resource not found, which is fine
              console.log(chalk.gray(`   → ${resource.type} '${resource.name}' not found (already deleted)`));
            }
          }
        }
      } catch (error: any) {
        stopSpinner();
        throw error;
      }

      console.log(chalk.green(`\n✅ Deleted '${appName}' and related resources.`));

      // Ask if user wants to delete the namespace (if it's not default)
      if (namespace !== 'default') {
        const deleteNamespaceAnswer = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'deleteNamespace',
            message: `Delete namespace '${namespace}' as well? (Warning: This will delete ALL resources in this namespace)`,
            default: false,
          },
        ]);

        if (deleteNamespaceAnswer.deleteNamespace) {
          console.log(chalk.yellow(`\n🗑️  Deleting namespace '${namespace}'...`));
          try {
            const deleteNsPromise = new Promise<void>((resolve, reject) => {
              const kubectl = spawn('kubectl', [
                'delete',
                'namespace',
                namespace,
                '--timeout=60s'
              ], {
                stdio: 'pipe',
              });

              let stdout = '';
              let stderr = '';

              kubectl.stdout?.on('data', (data) => {
                stdout += data.toString();
              });

              kubectl.stderr?.on('data', (data) => {
                stderr += data.toString();
              });

              kubectl.on('close', (code) => {
                if (code === 0) {
                  resolve();
                } else {
                  // Namespace deletion might take time, check if it's in Terminating state
                  if (stderr.includes('Terminating') || stdout.includes('Terminating')) {
                    console.log(chalk.cyan(`   → Namespace '${namespace}' is being deleted (Terminating state)`));
                    console.log(chalk.cyan(`   → This may take a few minutes. You can check status with:`));
                    console.log(chalk.cyan(`   → kubectl get namespace ${namespace}`));
                    resolve(); // Consider it successful if in Terminating state
                  } else {
                    reject(new Error(stderr || `Exit code: ${code}`));
                  }
                }
              });

              kubectl.on('error', (error) => {
                reject(error);
              });

              // Timeout after 65 seconds
              setTimeout(() => {
                kubectl.kill();
                // Check if namespace is in Terminating state
                try {
                  const nsStatus = execSync(
                    `kubectl get namespace ${namespace} -o jsonpath='{.status.phase}' 2>/dev/null || echo ""`,
                    { stdio: 'pipe', timeout: 5000 }
                  ).toString().trim();
                  if (nsStatus === 'Terminating') {
                    console.log(chalk.cyan(`   → Namespace '${namespace}' is in Terminating state`));
                    console.log(chalk.cyan(`   → Deletion is in progress, may take a few minutes`));
                    resolve();
                  } else {
                    reject(new Error('Timeout: namespace deletion took too long'));
                  }
                } catch (e) {
                  // Namespace might be deleted
                  resolve();
                }
              }, 65000);
            });

            await deleteNsPromise;
            console.log(chalk.green(`   ✓ Namespace '${namespace}' deleted`));
          } catch (error: any) {
            if (error.message.includes('Timeout')) {
              console.log(chalk.yellow(`   ⚠ Namespace deletion timed out, but may still be in progress`));
              console.log(chalk.cyan(`   → Check status: kubectl get namespace ${namespace}`));
            } else {
              console.log(chalk.yellow(`   ⚠ Could not delete namespace: ${error.message}`));
              console.log(chalk.cyan(`   → You can delete it manually: kubectl delete namespace ${namespace}`));
            }
          }
        }
      }

      // Optional: delete Cloudflare DNS record if config available
      const savedConfig = loadSavedConfig();
      const hasCF =
        savedConfig &&
        savedConfig.domain &&
        savedConfig.domain.domain &&
        savedConfig.domain.cloudflareApiToken &&
        savedConfig.domain.cloudflareZoneId;

      if (hasCF) {
        const hostname = savedConfig.domain!.subdomain
          ? `${savedConfig.domain!.subdomain}.${savedConfig.domain!.domain}`
          : savedConfig.domain!.domain;

        const dnsAnswer = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'deleteDNS',
            message: `Delete Cloudflare DNS record for ${hostname}?`,
            default: false,
          },
        ]);

        if (dnsAnswer.deleteDNS) {
          console.log(
            chalk.yellow(`   Deleting Cloudflare DNS record for ${hostname}...`)
          );
          await deleteCloudflareRecord({
            // minimal fields needed for DNS delete
            appType: 'nest',
            appName,
            port: 3000,
            replicas: 1,
            region: savedConfig.region || 'us-east-1',
            clusterName: savedConfig.clusterName || '',
            accessKeyId: savedConfig.accessKeyId || '',
            secretAccessKey: '',
            domain: savedConfig.domain as any,
          } as any);
        }
      }
    } catch (error: any) {
      console.error(chalk.red('\n❌ Delete failed:'));
      console.error(chalk.red(error.message));
      if (error.stack) {
        console.error(chalk.gray(error.stack));
      }
      process.exit(1);
    }
  });

program
  .command('fix-dns')
  .description('Fix or recreate DNS record for existing deployment')
  .option('-n, --namespace <ns>', 'Kubernetes namespace (optional, will prompt if not provided)')
  .action(async (options) => {
    try {
      console.log(chalk.blue.bold('\n🔧 EKSPressJS - Fix DNS Configuration\n'));

      console.log(chalk.cyan('\n🔍 Checking prerequisites...\n'));
      await checkPrerequisites();

      // Load saved config
      const savedConfig = loadSavedConfig();
      if (!savedConfig || !savedConfig.domain) {
        console.log(chalk.red('❌ No domain configuration found.'));
        console.log(chalk.yellow('   Please deploy first or configure domain manually.'));
        process.exit(1);
      }

      // Step 1: Fetch all namespaces
      let namespaces: string[] = [];
      try {
        const output = execSync('kubectl get namespaces -o json', {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
        const parsed = JSON.parse(output);
        namespaces =
          parsed.items?.map((ns: any) => ns.metadata?.name).filter(Boolean) || [];
      } catch (e: any) {
        console.log(chalk.red('❌ Could not list namespaces.'));
        throw e;
      }

      if (namespaces.length === 0) {
        console.log(chalk.yellow('⚠️  No namespaces found.'));
        return;
      }

      // Step 2: Select namespace
      let namespace = options.namespace || savedConfig.namespace;
      if (!namespace) {
        const nsAnswer = await inquirer.prompt([
          {
            type: 'list',
            name: 'namespace',
            message: 'Select namespace:',
            choices: [...namespaces, new inquirer.Separator(), 'Enter manually'],
          },
        ]);

        if (nsAnswer.namespace === 'Enter manually') {
          const manualNs = await inquirer.prompt([
            {
              type: 'input',
              name: 'namespace',
              message: 'Enter namespace name:',
              validate: (input: string) => {
                if (!input.trim()) {
                  return 'Namespace name cannot be empty';
                }
                return true;
              },
            },
          ]);
          namespace = manualNs.namespace.trim();
        } else {
          namespace = nsAnswer.namespace;
        }
      }

      // Step 3: Get app name
      const appName = savedConfig.appName || 'my-app';
      console.log(chalk.cyan(`\n📋 Checking ingress for '${appName}' in namespace '${namespace}'...`));

      // Step 4: Get ALB DNS from ingress
      let albDNS: string | null = null;
      try {
        const ingressInfo = execSync(
          `kubectl get ingress ${appName}-ingress -n ${namespace} -o json`,
          { encoding: 'utf-8', stdio: 'pipe' }
        );
        const ingress = JSON.parse(ingressInfo);
        albDNS = ingress.status?.loadBalancer?.ingress?.[0]?.hostname || null;

        if (!albDNS) {
          console.log(chalk.yellow(`⚠️  ALB DNS not found in ingress. ALB may still be provisioning.`));
          console.log(chalk.cyan(`   Check status: kubectl get ingress ${appName}-ingress -n ${namespace}`));
          console.log(chalk.cyan(`   Wait a few minutes and try again.`));
          return;
        }
      } catch (e: any) {
        console.log(chalk.red(`❌ Could not get ingress information.`));
        console.log(chalk.yellow(`   Make sure deployment exists: kubectl get ingress -n ${namespace}`));
        throw e;
      }

      console.log(chalk.green(`✓ Found ALB DNS: ${albDNS}`));

      // Step 5: Setup DNS
      const hostname = savedConfig.domain.subdomain
        ? `${savedConfig.domain.subdomain}.${savedConfig.domain.domain}`
        : savedConfig.domain.domain;

      console.log(chalk.blue(`\n🔧 Setting up DNS record for ${hostname}...`));

      const { setupCloudflareDNS } = await import('./aws-utils');
      await setupCloudflareDNS(
        {
          appType: 'nest',
          appName,
          port: savedConfig.port || 3000,
          replicas: savedConfig.replicas || 1,
          region: savedConfig.region || 'us-east-1',
          clusterName: savedConfig.clusterName || '',
          accessKeyId: savedConfig.accessKeyId || '',
          secretAccessKey: '',
          domain: savedConfig.domain as any,
        } as any,
        albDNS,
        false // Don't proxy initially
      );

      console.log(chalk.green(`\n✅ DNS record configured!`));
      console.log(chalk.cyan(`\n🌍 Your application should be accessible at:`));
      console.log(chalk.white(`   http://${hostname}`));
      console.log(chalk.gray(`   (DNS propagation may take a few minutes)`));
    } catch (error: any) {
      console.error(chalk.red('\n❌ Fix DNS failed:'));
      console.error(chalk.red(error.message));
      if (error.stack) {
        console.error(chalk.gray(error.stack));
      }
      process.exit(1);
    }
  });

program.parse();

