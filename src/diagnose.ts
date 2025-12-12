import { execSync } from 'child_process';
import chalk from 'chalk';
import { DeployConfig } from './types';
import { loadSavedConfig } from './prompts';

export async function checkSystemHealth(config: DeployConfig): Promise<void> {
    console.log(chalk.cyan('\n🏥 Checking System Health...'));

    const systemComponents = [
        { name: 'aws-node', label: 'VPC CNI (Networking)' },
        { name: 'coredns', label: 'CoreDNS (DNS Resolution)' },
        { name: 'kube-proxy', label: 'Kube Proxy' }
    ];

    let hasIssues = false;

    for (const component of systemComponents) {
        try {
            const pods = execSync(
                `kubectl get pods -n kube-system -l k8s-app=${component.name} -o jsonpath='{.items[*].status.phase}' 2>/dev/null || kubectl get pods -n kube-system -l App=${component.name} -o jsonpath='{.items[*].status.phase}' 2>/dev/null`,
                { encoding: 'utf-8' }
            ).trim();

            if (pods && pods.split(' ').every(status => status === 'Running')) {
                console.log(chalk.green(`   ✓ ${component.label}: OK`));
            } else if (!pods) {
                console.log(chalk.yellow(`   ⚠️  ${component.label}: Not found (may use different label)`));
            } else {
                console.log(chalk.red(`   ✗ ${component.label}: Unhealthy (Status: ${pods})`));
                hasIssues = true;
            }
        } catch (error) {
            console.log(chalk.yellow(`   ⚠️  ${component.label}: Could not check status`));
        }
    }

    if (hasIssues) {
        console.log(chalk.yellow('\n   ⚠️  System components are unhealthy. This often causes "stuck" deployments.'));
        console.log(chalk.white('      - If aws-node is failing, your nodes might lack CNI policy permissions.'));
    }
}

export async function checkPermissions(config: DeployConfig): Promise<void> {
    console.log(chalk.cyan('\n🔑 Checking Credentials & Permissions...'));

    try {
        const authStatus = execSync('kubectl auth can-i create pods', { encoding: 'utf-8' }).trim();
        if (authStatus === 'yes') {
            console.log(chalk.green('   ✓ Cluster Access: OK (Can create pods)'));
        } else {
            console.log(chalk.red('   ✗ Cluster Access: FAILED (Cannot create pods)'));
            console.log(chalk.yellow('      Check your kubeconfig and IAM mapping.'));
        }
    } catch (error) {
        console.log(chalk.red('   ✗ Cluster Access: Error connecting to cluster'));
    }

    // Check Node Identity
    try {
        const nodeRole = execSync(
            `aws sts get-caller-identity --query "Arn" --output text 2>/dev/null`,
            { encoding: 'utf-8' }
        ).trim();
        console.log(chalk.gray(`   Current Identity: ${nodeRole}`));
    } catch (error) {
        console.log(chalk.yellow('   ⚠️  Could not verify AWS identity (AWS CLI might not be configured)'));
    }
}

export async function diagnoseDeploymentFailure(config: DeployConfig): Promise<void> {
    const namespace = config.namespace || 'default';

    console.log(chalk.yellow('\n🔍 Diagnostics: Checking Pod Status...'));
    try {
        const pods = execSync(`kubectl get pods -n ${namespace} -l app=${config.appName} -o wide`, { encoding: 'utf-8' });
        console.log(chalk.gray(pods));

        // Check for ImagePullBackOff
        if (pods.includes('ImagePullBackOff') || pods.includes('ErrImagePull')) {
            console.log(chalk.red('\n   ✗ Issue Detected: ImagePullBackOff'));
            console.log(chalk.white('      The cluster cannot pull your container image.'));
            console.log(chalk.white('      Possible causes:'));
            console.log(chalk.white('      1. Image name/tag is incorrect.'));
            console.log(chalk.white('      2. Repository is private and missing imagePullSecrets.'));
            console.log(chalk.white('      3. Nodes lack IAM permission to pull from ECR (AmazonEC2ContainerRegistryReadOnly).'));
        }

        // Check for CreateContainerConfigError
        if (pods.includes('CreateContainerConfigError')) {
            console.log(chalk.red('\n   ✗ Issue Detected: Configuration Error'));
            console.log(chalk.white('      Missing ConfigMap or Secret referenced by the Pod.'));
        }

        // Check for Pending
        if (pods.includes('Pending')) {
            console.log(chalk.red('\n   ✗ Issue Detected: Pods Stuck in Pending'));
            console.log(chalk.white('      Possible causes:'));
            console.log(chalk.white('      1. Insufficient cluster resources (CPU/Memory).'));
            console.log(chalk.white('      2. No Nodes available (check `kubectl get nodes`).'));
            console.log(chalk.white('      3. PVC/Storage issues.'));
        }

    } catch (e) { console.log(chalk.gray('Could not get pods')); }

    console.log(chalk.yellow('\n🔍 Diagnostics: Pod Events (Why is it failing?)...'));
    try {
        // Get the name of the newest pod
        const podName = execSync(
            `kubectl get pods -n ${namespace} -l app=${config.appName} --sort-by=.metadata.creationTimestamp -o jsonpath='{.items[-1].metadata.name}'`,
            { encoding: 'utf-8' }
        ).trim();

        if (podName) {
            console.log(chalk.cyan(`   Inspecting Pod: ${podName}`));
            execSync(`kubectl describe pod ${podName} -n ${namespace} | grep -A 10 "Events:"`, { stdio: 'inherit' });

            console.log(chalk.yellow('\n🔍 Diagnostics: Pod Logs (Application Crash?)...'));
            try {
                execSync(`kubectl logs ${podName} -n ${namespace} --tail=20`, { stdio: 'inherit' });
            } catch (e) {
                console.log(chalk.yellow('   ⚠️  Could not fetch logs (Pod might be in ImagePullBackOff or ContainerCreating state)'));
            }
        }
    } catch (e) {
        console.log(chalk.gray('Could not analyze pod events'));
    }
}

export async function runDiagnostics(options: any): Promise<void> {
    let config: DeployConfig;

    // Try to load saved config
    const saved = loadSavedConfig();
    if (saved && saved.appName) {
        config = saved as DeployConfig;
        console.log(chalk.green(`✓ Loaded config for app: ${config.appName}`));
    } else {
        // Fallback or interactive (simplified for now)
        if (!options.name) {
            console.log(chalk.red('No configuration found. Please run this command in your project directory or provide --name.'));
            process.exit(1);
        }
        config = { appName: options.name } as DeployConfig;
    }

    console.log(chalk.blue.bold(`\n🕵️  Running Diagnostics for ${config.appName}...\n`));

    await checkPermissions(config);
    await checkSystemHealth(config);
    await diagnoseDeploymentFailure(config);

    console.log(chalk.blue('\n💡 Recommendation:'));
    console.log(chalk.white('   If you see "Unauthorized" or networking errors, check your Node Group IAM Role.'));
}
