#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { execSync } from 'child_process';
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
  .option('-f, --framework <type>', 'Framework type (next, nuxt, nest, react, vue)')
  .option('-a, --app <type>', 'Framework type (deprecated, use --framework)')
  .option('-n, --name <name>', 'Application name')
  .option('-p, --port <port>', 'Application port', '3000')
  .option('-r, --replicas <count>', 'Number of replicas', '2')
  .action(async (options) => {
    try {
      console.log(chalk.blue.bold('\n🚀 EKSPressJS - EKS Deployment Tool\n'));

      const frameworkType = options.framework || options.app;
      const validAppTypes = ['next', 'nuxt', 'nest', 'react', 'vue'];

      if (options.app && !options.framework) {
        console.log(chalk.yellow('⚠️  --app is deprecated, use --framework instead'));
      }

      if (!frameworkType || !validAppTypes.includes(frameworkType)) {
        console.error(chalk.red(`❌ Framework type is required`));
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
            execSync(
              `kubectl delete ${resource.type} ${resource.name} -n ${namespace} --ignore-not-found`,
              { stdio: 'pipe' }
            );
            stopSpinner();
            console.log(chalk.green(`   ✓ ${resource.type} '${resource.name}' deleted`));
          } catch (error: any) {
            stopSpinner();
            // Ignore errors for resources that don't exist (--ignore-not-found handles this)
            if (!error.message.includes('not found')) {
              console.log(chalk.yellow(`   ⚠ ${resource.type} '${resource.name}' - ${error.message}`));
            }
          }
        }
      } catch (error: any) {
        stopSpinner();
        throw error;
      }

      console.log(chalk.green(`\n✅ Deleted '${appName}' and related resources.`));

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

program.parse();

