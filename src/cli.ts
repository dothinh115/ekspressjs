#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { deployToEKS } from './deploy';
import { runDiagnostics } from './diagnose';
import { promptAWSConfig } from './prompts';
import { checkPrerequisites } from './utils';

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

program.parse();

