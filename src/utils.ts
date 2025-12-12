import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import inquirer from 'inquirer';
import chalk from 'chalk';

function checkToolInstalled(command: string): boolean {
  try {
    execSync(command, { stdio: 'pipe' });
    return true;
  } catch (error) {
    return false;
  }
}

function checkBrewInstalled(): boolean {
  return checkToolInstalled('brew --version');
}

async function installWithBrew(toolName: string, brewPackage: string, isCask: boolean = false): Promise<boolean> {
  try {
    console.log(chalk.blue(`   Installing ${toolName} via Homebrew...`));
    
    if (toolName === 'docker' && isCask) {
      console.log(chalk.yellow('   ⚠️  Docker Desktop requires manual installation'));
      console.log(chalk.cyan('   Please download from: https://www.docker.com/products/docker-desktop'));
      console.log(chalk.yellow('   After installation, make sure Docker Desktop is running'));
      
      const answer = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'dockerInstalled',
          message: 'Have you installed Docker Desktop and is it running?',
          default: false,
        },
      ]);

      if (answer.dockerInstalled) {
        if (checkToolInstalled('docker --version')) {
          console.log(chalk.green(`   ✓ Docker is installed and running`));
          return true;
        } else {
          console.log(chalk.red(`   ✗ Docker is not accessible. Please make sure Docker Desktop is running.`));
          return false;
        }
      }
      return false;
    }
    
    execSync(`brew install ${brewPackage}`, { stdio: 'inherit' });
    console.log(chalk.green(`   ✓ ${toolName} installed successfully`));
    return true;
  } catch (error: any) {
    console.log(chalk.red(`   ✗ Failed to install ${toolName}: ${error.message}`));
    return false;
  }
}

async function promptInstallBrew(): Promise<boolean> {
  const answer = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'installBrew',
      message: 'Homebrew is not installed. Install Homebrew first? (Recommended for macOS)',
      default: true,
    },
  ]);

  if (!answer.installBrew) {
    return false;
  }

  console.log(chalk.blue('\n📦 Installing Homebrew...'));
  console.log(chalk.yellow('This will run: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'));
  
  const confirm = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'proceed',
      message: 'Proceed with Homebrew installation?',
      default: true,
    },
  ]);

  if (!confirm.proceed) {
    return false;
  }

  try {
    execSync('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', {
      stdio: 'inherit',
    });
    console.log(chalk.green('✓ Homebrew installed successfully'));
    return true;
  } catch (error: any) {
    console.log(chalk.red(`✗ Failed to install Homebrew: ${error.message}`));
    console.log(chalk.yellow('Please install Homebrew manually: https://brew.sh'));
    return false;
  }
}

export async function checkPrerequisites(): Promise<void> {
  const checks = [
    { 
      name: 'docker', 
      command: 'docker --version',
      brewPackage: '--cask docker',
      installMac: 'brew install --cask docker',
      installMacAlt: 'Download Docker Desktop from https://www.docker.com/products/docker-desktop',
      installLinux: 'sudo apt-get install docker.io',
      installWindows: 'Download from https://www.docker.com/products/docker-desktop',
      url: 'https://docs.docker.com/get-docker/',
      required: true,
      isCask: true,
    },
    { 
      name: 'kubectl', 
      command: 'kubectl version --client',
      brewPackage: 'kubectl',
      installMac: 'brew install kubectl',
      installLinux: 'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl',
      installWindows: 'Download from https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/',
      url: 'https://kubernetes.io/docs/tasks/tools/',
      required: true,
    },
    { 
      name: 'eksctl', 
      command: 'eksctl version',
      brewPackage: 'eksctl',
      installMac: 'brew install eksctl',
      installLinux: 'curl -sSLo eksctl.tar.gz https://github.com/eksctl-io/eksctl/releases/latest/download/eksctl_$(uname -s)_amd64.tar.gz && tar -xzf eksctl.tar.gz -C /tmp && sudo mv /tmp/eksctl /usr/local/bin/ && rm eksctl.tar.gz',
      installWindows: 'Download from https://github.com/eksctl-io/eksctl/releases/latest',
      url: 'https://eksctl.io/introduction/installation/',
      required: true,
    },
    { 
      name: 'aws cli', 
      command: 'aws --version',
      brewPackage: 'awscli',
      installMac: 'brew install awscli',
      installLinux: 'pip install awscli',
      installWindows: 'Download from https://aws.amazon.com/cli/',
      url: 'https://aws.amazon.com/cli/',
      required: true,
    },
  ];

  const missing: any[] = [];
  const platform = process.platform;
  const isMac = platform === 'darwin';

  for (const check of checks) {
    if (!checkToolInstalled(check.command)) {
      missing.push(check);
    }
  }

  if (missing.length === 0) {
    return;
  }

  console.log(chalk.yellow('\n⚠️  Missing prerequisites:'));
  missing.forEach((check) => {
    console.log(chalk.yellow(`   - ${check.name}`));
  });

  if (isMac) {
    const hasBrew = checkBrewInstalled();
    
    if (!hasBrew) {
      console.log(chalk.cyan('\n💡 Homebrew not detected. Homebrew makes installation easier on macOS.'));
      const installBrew = await promptInstallBrew();
      
      if (!installBrew) {
        console.log(chalk.yellow('\n⚠️  Without Homebrew, you\'ll need to install tools manually:'));
        missing.forEach((check) => {
          console.log(chalk.yellow(`   ${check.name}: ${check.installMac}`));
          console.log(chalk.cyan(`   More info: ${check.url}`));
        });
        throw new Error('Missing prerequisites. Please install manually.');
      }
    }

    const installPrompts = missing.map((check) => ({
      type: 'confirm',
      name: check.name.replace(/\s+/g, '_'),
      message: `Install ${check.name}?`,
      default: true,
    }));

    const installAnswers = await inquirer.prompt(installPrompts);
    let awsInstalledNow = false;
    let eksctlInstalledNow = false;

    for (const check of missing) {
      const key = check.name.replace(/\s+/g, '_');
      if (installAnswers[key]) {
        const success = await installWithBrew(check.name, check.brewPackage, check.isCask);
        if (!success) {
          if (check.name === 'docker' && check.installMacAlt) {
            console.log(chalk.yellow(`\n⚠️  Please install ${check.name} manually:`));
            console.log(chalk.cyan(`   ${check.installMacAlt}`));
          } else {
            console.log(chalk.yellow(`\n⚠️  Please install ${check.name} manually:`));
            console.log(chalk.cyan(`   ${check.installMac}`));
          }
          console.log(chalk.cyan(`   More info: ${check.url}`));
          throw new Error(`Failed to install ${check.name}`);
        } else if (check.name === 'aws cli') {
          awsInstalledNow = true;
        } else if (check.name === 'eksctl') {
          eksctlInstalledNow = true;
        }
      } else {
        console.log(chalk.yellow(`\n⚠️  ${check.name} is required. Please install manually:`));
        if (check.name === 'docker' && check.installMacAlt) {
          console.log(chalk.cyan(`   ${check.installMacAlt}`));
        } else {
          console.log(chalk.cyan(`   ${check.installMac}`));
        }
        console.log(chalk.cyan(`   More info: ${check.url}`));
        throw new Error(`${check.name} is required`);
      }
    }

    if (awsInstalledNow) {
      const detected = detectAWSCredentials();
      if (!detected) {
        const configAns = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'configureAws',
            message: 'AWS CLI installed. Configure AWS credentials now?',
            default: true,
          },
        ]);

        if (configAns.configureAws) {
          await configureAWSCLIWithPrompts();
        } else {
          console.log(chalk.yellow('\n⚠️  Please run "aws configure" before deploying.'));
        }
      }
    }

    if (eksctlInstalledNow) {
      if (!checkToolInstalled('eksctl version')) {
        console.log(chalk.red('\n✗ eksctl is not accessible after install. Please ensure it is in PATH.'));
        throw new Error('eksctl is required');
      }
    }
  } else {
    console.log(chalk.yellow('\nPlease install the missing tools:'));
    missing.forEach((check) => {
      console.log(chalk.yellow(`\n${check.name}:`));
      if (platform === 'linux') {
        console.log(chalk.cyan(`   ${check.installLinux}`));
      } else {
        console.log(chalk.cyan(`   Download: ${check.installWindows}`));
      }
      console.log(chalk.cyan(`   More info: ${check.url}`));
    });
    
    const answer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'continue',
        message: 'Have you installed the missing tools? Continue anyway?',
        default: false,
      },
    ]);

    if (!answer.continue) {
      throw new Error('Please install the missing prerequisites and run again');
    }

    for (const check of missing) {
      if (!checkToolInstalled(check.command)) {
        throw new Error(`${check.name} is still not installed. Please install it and run again.`);
      }
    }
  }

  console.log(chalk.green('\n✅ All prerequisites are installed!'));
}

export async function configureAWSCLIWithPrompts(): Promise<void> {
  const answers = await inquirer.prompt([
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
    {
      type: 'input',
      name: 'region',
      message: 'Default AWS Region:',
      default: 'us-east-1',
      validate: (input: string) => input.length > 0 || 'Region is required',
    },
    {
      type: 'input',
      name: 'output',
      message: 'Default output format:',
      default: 'json',
    },
  ]);

  try {
    execSync(`aws configure set aws_access_key_id ${answers.accessKeyId}`, { stdio: 'inherit' });
    execSync(`aws configure set aws_secret_access_key ${answers.secretAccessKey}`, { stdio: 'inherit' });
    execSync(`aws configure set region ${answers.region}`, { stdio: 'inherit' });
    execSync(`aws configure set output ${answers.output}`, { stdio: 'inherit' });
    console.log(chalk.green('✓ AWS CLI configured successfully'));
  } catch (error: any) {
    console.log(chalk.red(`✗ Failed to configure AWS CLI: ${error.message}`));
    throw error;
  }
}

export function detectAWSCredentials(): { accessKeyId?: string; secretAccessKey?: string; region?: string } | null {
  const homeDir = os.homedir();
  const credentialsPath = path.join(homeDir, '.aws', 'credentials');
  const configPath = path.join(homeDir, '.aws', 'config');

  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION,
    };
  }

  if (fs.existsSync(credentialsPath)) {
    try {
      const credentialsContent = fs.readFileSync(credentialsPath, 'utf-8');
      const accessKeyMatch = credentialsContent.match(/aws_access_key_id\s*=\s*(.+)/i);
      const secretKeyMatch = credentialsContent.match(/aws_secret_access_key\s*=\s*(.+)/i);

      if (accessKeyMatch && secretKeyMatch) {
        let region: string | undefined;
        
        if (fs.existsSync(configPath)) {
          try {
            const configContent = fs.readFileSync(configPath, 'utf-8');
            const regionMatch = configContent.match(/region\s*=\s*(.+)/i);
            if (regionMatch) {
              region = regionMatch[1].trim();
            }
          } catch (error) {
          }
        }

        return {
          accessKeyId: accessKeyMatch[1].trim(),
          secretAccessKey: secretKeyMatch[1].trim(),
          region,
        };
      }
    } catch (error) {
    }
  }

  try {
    const awsRegion = execSync('aws configure get region', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    const awsAccessKey = execSync('aws configure get aws_access_key_id', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    const awsSecretKey = execSync('aws configure get aws_secret_access_key', { encoding: 'utf-8', stdio: 'pipe' }).trim();

    if (awsAccessKey && awsSecretKey && awsAccessKey !== '' && awsSecretKey !== '') {
      return {
        accessKeyId: awsAccessKey,
        secretAccessKey: awsSecretKey,
        region: awsRegion || undefined,
      };
    }
  } catch (error) {
  }

  return null;
}

export function validateProjectStructure(appType: string): void {
  const requiredFiles: Record<string, string[]> = {
    next: ['package.json', 'next.config.js'],
    nuxt: ['package.json', 'nuxt.config.ts', 'nuxt.config.js'],
    nest: ['package.json', 'nest-cli.json'],
    react: ['package.json'],
    vue: ['package.json'],
  };

  const files = requiredFiles[appType] || ['package.json'];

  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.log(
        chalk.yellow(`⚠️  Warning: ${file} not found. Make sure you're in the project root.`)
      );
    }
  }
}

export async function createNextConfigIfNeeded(): Promise<void> {
  const nextConfigPath = path.join(process.cwd(), 'next.config.js');
  const nextConfigTsPath = path.join(process.cwd(), 'next.config.ts');

  if (fs.existsSync(nextConfigPath) || fs.existsSync(nextConfigTsPath)) {
    const configPath = fs.existsSync(nextConfigPath) ? nextConfigPath : nextConfigTsPath;
    const configContent = await fs.readFile(configPath, 'utf-8');

    if (!configContent.includes('output') || !configContent.includes('standalone')) {
      console.log(
        chalk.yellow(
          '\n⚠️  Warning: Next.js config may need output: "standalone" for optimal Docker builds.'
        )
      );
      console.log(chalk.yellow('   Add this to your next.config.js:'));
      console.log(chalk.cyan('   output: "standalone"'));
    }
  }
}

