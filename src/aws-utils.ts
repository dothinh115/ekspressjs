import { execSync } from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import axios from 'axios';
import { EKSClient, DescribeClusterCommand, ListClustersCommand, CreateClusterCommand } from '@aws-sdk/client-eks';
import { ACMClient, RequestCertificateCommand, DescribeCertificateCommand, ListCertificatesCommand } from '@aws-sdk/client-acm';
import chalk from 'chalk';
import { DeployConfig } from './types';

export async function checkClusterExists(config: DeployConfig): Promise<boolean> {
  try {
    const eksClient = new EKSClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    const command = new DescribeClusterCommand({ name: config.clusterName });
    await eksClient.send(command);
    return true;
  } catch (error: any) {
    if (error.name === 'ResourceNotFoundException') {
      return false;
    }
    throw error;
  }
}

export async function listClusters(config: DeployConfig): Promise<string[]> {
  try {
    const eksClient = new EKSClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    const command = new ListClustersCommand({});
    const response = await eksClient.send(command);
    return response.clusters || [];
  } catch (error: any) {
    return [];
  }
}

export async function configureAWS(config: DeployConfig): Promise<void> {
  process.env.AWS_ACCESS_KEY_ID = config.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = config.secretAccessKey;
  process.env.AWS_DEFAULT_REGION = config.region;
  process.env.AWS_REGION = config.region;

  const exists = await checkClusterExists(config);
  if (exists) {
    console.log(chalk.green(`   ✓ Cluster '${config.clusterName}' found`));
  } else {
    throw new Error(`Cluster '${config.clusterName}' not found`);
  }
}

export async function checkAndEnsureNodes(config: DeployConfig): Promise<void> {
  try {
    const nodesResult = execSync(
      `kubectl get nodes --no-headers 2>/dev/null | wc -l || echo "0"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    const nodeCount = parseInt(nodesResult.trim()) || 0;

    if (nodeCount > 0) {
      const readyNodes = execSync(
        `kubectl get nodes --no-headers 2>/dev/null | grep -c Ready || echo "0"`,
        { encoding: 'utf-8', stdio: 'pipe' }
      );
      const readyCount = parseInt(readyNodes.trim()) || 0;

      if (readyCount > 0) {
        console.log(chalk.green(`   ✓ Cluster has ${readyCount} ready node(s)`));
        return;
      } else {
        console.log(chalk.yellow(`   ⚠️  Cluster has ${nodeCount} node(s) but none are Ready`));
      }
    } else {
      console.log(chalk.yellow('   ⚠️  No nodes found in cluster. Checking node groups...'));
    }

    try {
      const nodeGroupsResult = execSync(
        `eksctl get nodegroup --cluster=${config.clusterName} --region=${config.region} -o json 2>/dev/null || echo "[]"`,
        { encoding: 'utf-8', stdio: 'pipe' }
      );
      const nodeGroups = JSON.parse(nodeGroupsResult.trim());

      if (nodeGroups && nodeGroups.length > 0) {
        const activeGroups = nodeGroups.filter((ng: any) => ng.Status === 'ACTIVE');
        if (activeGroups.length > 0) {
          const nodeGroup = activeGroups[0];
          const desiredSize = nodeGroup.DesiredCapacity || 0;
          const currentSize = nodeGroup.CurrentCapacity || 0;

          if (currentSize === 0 && desiredSize === 0) {
            console.log(chalk.blue(`   Scaling up node group '${nodeGroup.Name}' to 1 node...`));
            execSync(
              `eksctl scale nodegroup --cluster=${config.clusterName} --name=${nodeGroup.Name} --nodes=1 --region=${config.region}`,
              { stdio: 'inherit', env: { ...process.env } }
            );
          } else if (desiredSize > 0 && currentSize === 0) {
            console.log(chalk.yellow(`   Node group '${nodeGroup.Name}' is scaling (desired: ${desiredSize}, current: ${currentSize})`));
          } else {
            console.log(chalk.yellow(`   Node group '${nodeGroup.Name}' exists but nodes may not be ready yet`));
          }
        } else {
          console.log(chalk.yellow('   Node groups exist but none are ACTIVE'));
        }
      } else {
        console.log(chalk.blue('   No node groups found. Creating default node group...'));
        execSync(
          `eksctl create nodegroup --cluster=${config.clusterName} --nodes=1 --node-type=t3.small --region=${config.region} --managed`,
          { stdio: 'inherit', env: { ...process.env } }
        );
      }
    } catch (error: any) {
      console.log(chalk.yellow(`   ⚠️  Could not check/create node groups: ${error.message}`));
      console.log(chalk.cyan('   Please create node group manually:'));
      console.log(chalk.white(`   eksctl create nodegroup --cluster=${config.clusterName} --nodes=1 --node-type=t3.small --region=${config.region}`));
      throw new Error('Cluster has no nodes. Please create a node group and try again.');
    }

    console.log(chalk.blue('   Waiting for nodes to be ready...'));
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 10000));

      const readyNodes = execSync(
        `kubectl get nodes --no-headers 2>/dev/null | grep -c Ready || echo "0"`,
        { encoding: 'utf-8', stdio: 'pipe' }
      );
      const readyCount = parseInt(readyNodes.trim()) || 0;

      if (readyCount > 0) {
        console.log(chalk.green(`   ✓ ${readyCount} node(s) are now ready!`));
        return;
      }

      if (i % 3 === 0 && i > 0) {
        const elapsed = (i + 1) * 10;
        console.log(chalk.yellow(`   Still waiting for nodes... (${elapsed}s elapsed)`));
      }
    }

    throw new Error('Nodes did not become ready after 10 minutes. Please check node group status manually.');
  } catch (error: any) {
    if (error.message.includes('Nodes did not become ready')) {
      throw error;
    }
    console.log(chalk.yellow(`   ⚠️  Could not ensure nodes: ${error.message}`));
  }
}

export async function checkAndFixALBIAMPermissions(config: DeployConfig): Promise<void> {
  try {
    console.log(chalk.blue('   Checking ALB Controller IAM permissions...'));
    
    // Check if service account exists
    const saCheck = execSync(
      `kubectl get serviceaccount aws-load-balancer-controller -n kube-system -o json 2>/dev/null || echo "not found"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );

    if (saCheck.includes('not found')) {
      console.log(chalk.yellow('   ⚠️  ALB Controller service account not found'));
      return;
    }

    // Check for IAM permission errors in ingress events
    try {
      const ingressEvents = execSync(
        `kubectl get events -n ${config.namespace || 'default'} --field-selector involvedObject.name=${config.appName}-ingress --sort-by='.lastTimestamp' -o json 2>/dev/null || echo "{}"`,
        { encoding: 'utf-8', stdio: 'pipe' }
      );
      const events = JSON.parse(ingressEvents);
      const failedEvents = events.items?.filter((e: any) => 
        e.type === 'Warning' && 
        e.reason === 'FailedBuildModel' && 
        (e.message?.includes('UnauthorizedOperation') || e.message?.includes('not authorized'))
      );

      if (failedEvents && failedEvents.length > 0) {
        const needsEC2Perms = failedEvents.some((e: any) => 
          e.message?.includes('ec2:DescribeAvailabilityZones') || 
          e.message?.includes('ec2:DescribeSubnets') ||
          e.message?.includes('ec2:DescribeVpcs')
        );

        if (needsEC2Perms) {
          console.log(chalk.yellow('   ⚠️  ALB Controller needs additional EC2 permissions'));
          console.log(chalk.blue('   Adding EC2 read permissions to ALB Controller IAM role...'));
          
          try {
            // Get the IAM role ARN from service account annotation
            const saInfo = execSync(
              `kubectl get serviceaccount aws-load-balancer-controller -n kube-system -o jsonpath='{.metadata.annotations.eks\\.amazonaws\\.com/role-arn}'`,
              { encoding: 'utf-8', stdio: 'pipe' }
            );
            
            if (saInfo && saInfo.trim()) {
              const roleName = saInfo.split('/').pop();
              console.log(chalk.cyan(`   Found IAM role: ${roleName}`));
              
              // Try to automatically fix by updating service account with eksctl
              console.log(chalk.blue('   Attempting to automatically fix IAM permissions...'));
              try {
                execSync(
                  `eksctl create iamserviceaccount --cluster=${config.clusterName} --namespace=kube-system --name=aws-load-balancer-controller --attach-policy-arn=arn:aws:iam::aws:policy/ElasticLoadBalancingFullAccess --attach-policy-arn=arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess --override-existing-serviceaccounts --approve --region=${config.region}`,
                  { stdio: 'inherit', env: { ...process.env } }
                );
                console.log(chalk.green('   ✓ Successfully updated ALB Controller IAM permissions'));
                console.log(chalk.cyan('   Restarting ALB Controller pods to apply new permissions...'));
                execSync(
                  `kubectl rollout restart deployment aws-load-balancer-controller -n kube-system`,
                  { stdio: 'pipe' }
                );
                console.log(chalk.green('   ✓ ALB Controller pods restarted'));
                console.log(chalk.cyan('   Waiting 30 seconds for pods to restart...'));
                await new Promise(resolve => setTimeout(resolve, 30000));
              } catch (eksctlError: any) {
                // eksctl often says "no tasks" when service account already exists
                // Try AWS CLI directly as fallback
                console.log(chalk.yellow('   ⚠️  eksctl reported no changes needed, trying AWS CLI to ensure permissions...'));
                try {
                  // Check if policy is already attached
                  const checkResult = execSync(
                    `aws iam list-attached-role-policies --role-name ${roleName} --region ${config.region} --query 'AttachedPolicies[?PolicyArn==\`arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess\`]' --output json`,
                    { encoding: 'utf-8', stdio: 'pipe', env: { ...process.env } }
                  );
                  const policies = JSON.parse(checkResult);
                  
                  if (policies && policies.length > 0) {
                    console.log(chalk.green('   ✓ EC2 permissions already attached'));
                  } else {
                    console.log(chalk.blue('   Attaching EC2 read permissions via AWS CLI...'));
                    execSync(
                      `aws iam attach-role-policy --role-name ${roleName} --policy-arn arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess --region ${config.region}`,
                      { stdio: 'pipe', env: { ...process.env } }
                    );
                    console.log(chalk.green('   ✓ Successfully attached EC2 read permissions via AWS CLI'));
                  }
                  
                  console.log(chalk.cyan('   Restarting ALB Controller pods to apply permissions...'));
                  execSync(
                    `kubectl rollout restart deployment aws-load-balancer-controller -n kube-system`,
                    { stdio: 'pipe' }
                  );
                  console.log(chalk.green('   ✓ ALB Controller pods restarted'));
                  console.log(chalk.cyan('   Waiting 30 seconds for pods to restart...'));
                  await new Promise(resolve => setTimeout(resolve, 30000));
                } catch (awsCliError: any) {
                  console.log(chalk.yellow('   ⚠️  Automatic fix failed. Please add EC2 permissions manually:'));
                  console.log(chalk.white('      Policy: AmazonEC2ReadOnlyAccess'));
                  console.log(chalk.white('      Or create custom policy with:'));
                  console.log(chalk.white('        - ec2:DescribeAvailabilityZones'));
                  console.log(chalk.white('        - ec2:DescribeSubnets'));
                  console.log(chalk.white('        - ec2:DescribeVpcs'));
                  console.log(chalk.cyan(`   IAM Role: ${saInfo.trim()}`));
                  console.log(chalk.cyan(`   Command: aws iam attach-role-policy --role-name ${roleName} --policy-arn arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess`));
                  console.log(chalk.cyan(`   AWS Console: IAM > Roles > ${roleName} > Add permissions`));
                }
              }
            } else {
              console.log(chalk.yellow('   ⚠️  Could not find IAM role. Trying to update service account...'));
              // Try to update service account with additional policy
              try {
                execSync(
                  `eksctl create iamserviceaccount --cluster=${config.clusterName} --namespace=kube-system --name=aws-load-balancer-controller --attach-policy-arn=arn:aws:iam::aws:policy/ElasticLoadBalancingFullAccess --attach-policy-arn=arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess --override-existing-serviceaccounts --approve --region=${config.region}`,
                  { stdio: 'inherit', env: { ...process.env } }
                );
                console.log(chalk.green('   ✓ Updated ALB Controller IAM permissions'));
                console.log(chalk.cyan('   Restarting ALB Controller pods to apply new permissions...'));
                execSync(
                  `kubectl rollout restart deployment aws-load-balancer-controller -n kube-system`,
                  { stdio: 'pipe' }
                );
                await new Promise(resolve => setTimeout(resolve, 30000));
              } catch (error: any) {
                console.log(chalk.yellow(`   ⚠️  Could not update: ${error.message}`));
              }
            }
          } catch (error: any) {
            console.log(chalk.yellow(`   ⚠️  Could not automatically fix IAM permissions: ${error.message}`));
            console.log(chalk.cyan('   Please manually add EC2 read permissions to ALB Controller IAM role'));
          }
        }
      }
    } catch (error) {
      // Ignore errors checking events
    }
  } catch (error: any) {
    // Ignore errors
  }
}

export async function checkAndInstallALBController(config: DeployConfig): Promise<void> {
  try {
    const result = execSync(
      `kubectl get deployment aws-load-balancer-controller -n kube-system -o json 2>/dev/null || echo "not found"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );

    if (result.includes('not found') || result.trim() === '') {
      console.log(chalk.yellow('   ⚠️  AWS Load Balancer Controller not found. Installing...'));

      try {
        console.log(chalk.blue('   Creating IAM service account with required permissions...'));
        // Install with both ELB and EC2 permissions from the start
        execSync(
          `eksctl create iamserviceaccount --cluster=${config.clusterName} --namespace=kube-system --name=aws-load-balancer-controller --attach-policy-arn=arn:aws:iam::aws:policy/ElasticLoadBalancingFullAccess --attach-policy-arn=arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess --override-existing-serviceaccounts --approve --region=${config.region}`,
          { stdio: 'inherit', env: { ...process.env } }
        );

        console.log(chalk.blue('   Checking Helm installation...'));
        try {
          execSync(`helm version`, { stdio: 'pipe' });
        } catch (error) {
          console.log(chalk.yellow('   Helm not found. Installing Helm...'));
          execSync(`brew install helm`, { stdio: 'inherit' });
        }

        console.log(chalk.blue('   Installing AWS Load Balancer Controller via Helm...'));
        execSync(`helm repo add eks https://aws.github.io/eks-charts 2>/dev/null || true`, { stdio: 'pipe' });
        execSync(`helm repo update`, { stdio: 'pipe' });

        try {
          execSync(
            `helm install aws-load-balancer-controller eks/aws-load-balancer-controller -n kube-system --set clusterName=${config.clusterName} --set serviceAccount.create=false --set serviceAccount.name=aws-load-balancer-controller --wait --timeout=10m`,
            { stdio: 'inherit' }
          );
          console.log(chalk.green('   ✓ AWS Load Balancer Controller installed'));
        } catch (error: any) {
          console.log(chalk.yellow('   ⚠️  Install with --wait timed out, checking status...'));

          const checkResult = execSync(
            `kubectl get deployment aws-load-balancer-controller -n kube-system -o json 2>/dev/null || echo "not found"`,
            { encoding: 'utf-8', stdio: 'pipe' }
          );

          if (!checkResult.includes('not found') && checkResult.trim() !== '') {
            console.log(chalk.green('   ✓ AWS Load Balancer Controller is installing (may take a few minutes)'));
            console.log(chalk.cyan('   You can check status: kubectl get deployment aws-load-balancer-controller -n kube-system'));
          } else {
            console.log(chalk.yellow('   Trying upgrade/install without wait...'));
            execSync(
              `helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller -n kube-system --set clusterName=${config.clusterName} --set serviceAccount.create=false --set serviceAccount.name=aws-load-balancer-controller --timeout=10m`,
              { stdio: 'inherit' }
            );
            console.log(chalk.green('   ✓ AWS Load Balancer Controller installation initiated'));
            console.log(chalk.cyan('   It may take 2-5 minutes to be ready. Checking status...'));

            for (let i = 0; i < 30; i++) {
              await new Promise(resolve => setTimeout(resolve, 10000));
              const statusResult = execSync(
                `kubectl get deployment aws-load-balancer-controller -n kube-system -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0"`,
                { encoding: 'utf-8', stdio: 'pipe' }
              );
              if (statusResult.trim() === '1' || statusResult.trim() === '2') {
                console.log(chalk.green('   ✓ AWS Load Balancer Controller is ready'));
                await waitForALBWebhookReady(90);
                return;
              }
            }

            console.log(chalk.yellow('   ⚠️  ALB Controller is still starting. Waiting for webhook...'));
            await waitForALBWebhookReady(90);
          }
        }
      } catch (error: any) {
        console.log(chalk.yellow(`   ⚠️  Failed to install ALB Controller automatically: ${error.message}`));
        console.log(chalk.cyan('   Please install manually: https://kubernetes-sigs.github.io/aws-load-balancer-controller/v2.7/guide/installation/'));
        throw error;
      }
    } else {
      console.log(chalk.green('   ✓ AWS Load Balancer Controller already installed'));
      
      // Check and fix IAM permissions if needed
      await checkAndFixALBIAMPermissions(config);
      
      await waitForALBWebhookReady(90);
    }
  } catch (error: any) {
    console.log(chalk.yellow('   ⚠️  Could not check ALB Controller status'));
  }
}

async function checkALBPodReady(): Promise<boolean> {
  try {
    const podStatus = execSync(
      `kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo ""`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    return podStatus.trim() === 'Running';
  } catch (error) {
    return false;
  }
}

async function getALBPodStatus(): Promise<{ phase: string; reason?: string; message?: string; conditions?: any[] } | null> {
  try {
    const podInfo = execSync(
      `kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller -o json 2>/dev/null || echo "{}"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    const pod = JSON.parse(podInfo);
    if (pod.items && pod.items.length > 0) {
      const podStatus = pod.items[0].status;
      const containerStatus = podStatus.containerStatuses?.[0];
      const waitingState = containerStatus?.state?.waiting;
      const pendingReason = podStatus.conditions?.find((c: any) => c.type === 'PodScheduled' && c.status !== 'True');

      return {
        phase: podStatus.phase || 'Unknown',
        reason: waitingState?.reason || containerStatus?.state?.terminated?.reason || pendingReason?.reason,
        message: waitingState?.message || containerStatus?.state?.terminated?.message || pendingReason?.message,
        conditions: podStatus.conditions,
      };
    }
  } catch (error) {
  }
  return null;
}

async function showALBDiagnostics(): Promise<void> {
  console.log(chalk.cyan('\n   🔍 ALB Controller Diagnostics:'));

  try {
    const podStatus = await getALBPodStatus();
    if (podStatus) {
      console.log(chalk.white(`   Pod Status: ${podStatus.phase}`));
      if (podStatus.reason) {
        console.log(chalk.yellow(`   Reason: ${podStatus.reason}`));
      }
      if (podStatus.message) {
        console.log(chalk.yellow(`   Message: ${podStatus.message}`));
      }

      if (podStatus.conditions) {
        const unscheduled = podStatus.conditions.find((c: any) => c.type === 'PodScheduled' && c.status !== 'True');
        if (unscheduled) {
          console.log(chalk.red(`   ⚠️  Pod not scheduled: ${unscheduled.reason || 'Unknown'}`));
          if (unscheduled.message) {
            console.log(chalk.yellow(`      ${unscheduled.message}`));
          }
        }
      }
    }
  } catch (error) {
  }

  try {
    const podInfo = execSync(
      `kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller -o wide 2>/dev/null || echo ""`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    if (podInfo.trim()) {
      console.log(chalk.cyan('\n   Pod details:'));
      console.log(chalk.gray(podInfo.trim()));
    }
  } catch (error) {
  }

  try {
    const podLogs = execSync(
      `kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller --tail=10 2>/dev/null || echo ""`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    if (podLogs.trim()) {
      console.log(chalk.cyan('\n   Recent logs:'));
      console.log(chalk.gray(podLogs.trim().split('\n').slice(-5).join('\n')));
    } else {
      console.log(chalk.yellow('\n   No logs available (pod may not be running yet)'));
    }
  } catch (error) {
    console.log(chalk.yellow('\n   Could not fetch logs (pod may not be running yet)'));
  }

  try {
    const events = execSync(
      `kubectl get events -n kube-system --field-selector involvedObject.kind=Pod --sort-by='.lastTimestamp' | grep -i "load-balancer" | tail -10 2>/dev/null || kubectl get events -n kube-system --sort-by='.lastTimestamp' | tail -10 2>/dev/null || echo ""`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    if (events.trim()) {
      console.log(chalk.cyan('\n   Recent events:'));
      console.log(chalk.gray(events.trim()));
    }
  } catch (error) {
  }

  try {
    const nodes = execSync(
      `kubectl get nodes 2>/dev/null || echo ""`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    if (nodes.trim()) {
      console.log(chalk.cyan('\n   Cluster nodes:'));
      console.log(chalk.gray(nodes.trim()));

      const nodeLines = nodes.trim().split('\n').slice(1);
      if (nodeLines.length === 0) {
        console.log(chalk.red('\n   ⚠️  NO NODES FOUND IN CLUSTER!'));
        console.log(chalk.yellow('   This is the root cause. Your EKS cluster has no worker nodes.'));
        console.log(chalk.cyan('   Solution: Add nodes to your cluster or check node group status.'));
      } else {
        const notReadyNodes = nodeLines.filter((line: string) => line.includes('NotReady'));
        if (notReadyNodes.length > 0) {
          console.log(chalk.yellow(`\n   ⚠️  ${notReadyNodes.length} node(s) are NotReady`));
        }
      }
    } else {
      console.log(chalk.red('\n   ⚠️  NO NODES FOUND IN CLUSTER!'));
      console.log(chalk.yellow('   This is the root cause. Your EKS cluster has no worker nodes.'));
    }
  } catch (error) {
    console.log(chalk.red('\n   ⚠️  Could not check nodes (cluster may not be accessible)'));
  }

  try {
    const nodeResources = execSync(
      `kubectl top nodes 2>/dev/null || echo ""`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    if (nodeResources.trim()) {
      console.log(chalk.cyan('\n   Node resources:'));
      console.log(chalk.gray(nodeResources.trim()));
    }
  } catch (error) {
    console.log(chalk.yellow('\n   Node resource metrics not available (metrics-server may not be installed)'));
  }

  try {
    const nodeGroups = execSync(
      `eksctl get nodegroup --cluster=${process.env.AWS_DEFAULT_REGION || 'default'} 2>/dev/null || echo ""`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    if (nodeGroups.trim() && !nodeGroups.includes('error')) {
      console.log(chalk.cyan('\n   Node groups:'));
      console.log(chalk.gray(nodeGroups.trim()));
    }
  } catch (error) {
  }

  console.log(chalk.cyan('\n   Common issues and solutions:'));

  const podStatus = await getALBPodStatus();
  if (podStatus?.reason === 'Unschedulable' && podStatus?.message?.includes('no nodes available')) {
    console.log(chalk.red('   ⚠️  CRITICAL: No nodes available in cluster!'));
    console.log(chalk.yellow('   1. Check if your EKS cluster has worker nodes:'));
    console.log(chalk.white('      kubectl get nodes'));
    console.log(chalk.yellow('   2. If no nodes, check node group status:'));
    console.log(chalk.white(`      eksctl get nodegroup --cluster=<your-cluster-name> --region=<your-region>`));
    console.log(chalk.yellow('   3. If node group exists but nodes are missing:'));
    console.log(chalk.white('      - Check node group in AWS Console (EC2 > Auto Scaling Groups)'));
    console.log(chalk.white('      - Check if nodes were terminated due to free tier limits'));
    console.log(chalk.white('      - Scale up node group: eksctl scale nodegroup --cluster=<name> --nodes=1'));
    console.log(chalk.yellow('   4. If no node group exists, create one:'));
    console.log(chalk.white(`      eksctl create nodegroup --cluster=<your-cluster-name> --nodes=1 --node-type=t3.small --region=<your-region>`));
  } else {
    console.log(chalk.yellow('   1. Insufficient resources:'));
    console.log(chalk.white('      - Check: kubectl describe nodes'));
    console.log(chalk.white('      - Free tier t3.small may be too small for ALB Controller'));
    console.log(chalk.white('      - Solution: Use t3.medium or larger, or scale up nodes'));
    console.log(chalk.yellow('   2. IAM permissions:'));
    console.log(chalk.white('      - Check: kubectl describe sa aws-load-balancer-controller -n kube-system'));
    console.log(chalk.white('      - Ensure service account has ElasticLoadBalancingFullAccess'));
    console.log(chalk.yellow('   3. Subnet tags:'));
    console.log(chalk.white('      - Public subnets need: kubernetes.io/role/elb=1'));
    console.log(chalk.white('      - Check: aws ec2 describe-subnets --filters "Name=tag:Name,Values=*"'));
    console.log(chalk.yellow('   4. Image pull issues:'));
    console.log(chalk.white('      - Check: kubectl describe pod -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller'));
    console.log(chalk.white('      - May need to configure image pull secrets'));
  }
}

async function checkALBDeploymentReady(): Promise<boolean> {
  try {
    const readyReplicas = execSync(
      `kubectl get deployment aws-load-balancer-controller -n kube-system -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    return readyReplicas.trim() === '1' || readyReplicas.trim() === '2';
  } catch (error) {
    return false;
  }
}

async function waitForALBWebhookReady(maxWaitSeconds: number = 120): Promise<boolean> {
  console.log(chalk.blue(`   Waiting for ALB Controller webhook to be ready (max ${maxWaitSeconds}s)...`));

  const startTime = Date.now();
  let podReady = false;
  let deploymentReady = false;
  const maxIterations = Math.floor(maxWaitSeconds / 3);

  for (let i = 0; i < maxIterations; i++) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (!podReady) {
      podReady = await checkALBPodReady();
      if (podReady) {
        console.log(chalk.green('   ✓ ALB Controller pod is running'));
      }
    }

    if (!deploymentReady) {
      deploymentReady = await checkALBDeploymentReady();
      if (deploymentReady) {
        console.log(chalk.green('   ✓ ALB Controller deployment is ready'));
      }
    }

    if (podReady && deploymentReady) {
      try {
        const endpointsResult = execSync(
          `kubectl get endpoints aws-load-balancer-webhook-service -n kube-system -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null || echo ""`,
          { encoding: 'utf-8', stdio: 'pipe' }
        );

        if (endpointsResult.trim() !== '') {
          console.log(chalk.green('   ✓ ALB Controller webhook endpoints are ready'));
          await new Promise(resolve => setTimeout(resolve, 2000));
          return true;
        }
      } catch (error) {
      }
    }

    if (i % 4 === 0 && i > 0) {
      const status = [];
      if (podReady) status.push('pod');
      if (deploymentReady) status.push('deployment');
      if (status.length > 0) {
        console.log(chalk.yellow(`   Still waiting for webhook endpoints... (${status.join(', ')} ready, ${elapsed}s/${maxWaitSeconds}s)`));
      } else {
        console.log(chalk.yellow(`   Still waiting... (${elapsed}s/${maxWaitSeconds}s)`));
      }
    }

    if (i < maxIterations - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  const finalElapsed = Math.floor((Date.now() - startTime) / 1000);
  console.log(chalk.red(`   ✗ ALB Controller webhook not ready after ${finalElapsed}s.`));

  const podStatus = await getALBPodStatus();
  if (podStatus && podStatus.phase !== 'Running') {
    console.log(chalk.red(`   ✗ ALB Controller pod is not Running (status: ${podStatus.phase})`));
    if (podStatus.reason) {
      console.log(chalk.yellow(`   Reason: ${podStatus.reason}`));
    }
    await showALBDiagnostics();
  }

  console.log(chalk.yellow('   Will retry on apply with timeout...'));
  return false;
}

export async function setupKubectl(config: DeployConfig): Promise<void> {
  try {
    execSync(
      `aws eks update-kubeconfig --region ${config.region} --name ${config.clusterName}`,
      { stdio: 'inherit', env: { ...process.env } }
    );

    execSync('kubectl cluster-info', { stdio: 'pipe' });
    console.log(chalk.green('   ✓ kubectl configured successfully'));
  } catch (error: any) {
    throw new Error(`Failed to setup kubectl: ${error.message}`);
  }
}

export async function setupECRImagePullSecret(config: DeployConfig): Promise<void> {
  if (!config.imageRegistry || !config.imageRegistry.includes('amazonaws.com')) {
    return;
  }

  const namespace = config.namespace || 'default';
  const secretName = 'ecr-registry-secret';

  try {
    // Check if secret already exists
    const secretCheck = execSync(
      `kubectl get secret ${secretName} -n ${namespace} 2>/dev/null || echo "not found"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );

    if (!secretCheck.includes('not found')) {
      console.log(chalk.green(`   ✓ ECR ImagePullSecret already exists`));
      return;
    }

    console.log(chalk.blue('   Setting up ECR ImagePullSecret for cluster...'));

    // Extract registry URL from ECR URI
    // ECR format: {account-id}.dkr.ecr.{region}.amazonaws.com
    // User input is typically just the registry URL (no path)
    let registryUrl = config.imageRegistry.trim();
    
    // Remove https:// if present
    if (registryUrl.startsWith('https://')) {
      registryUrl = registryUrl.replace('https://', '');
    }
    
    // Remove trailing slash if present
    registryUrl = registryUrl.replace(/\/$/, '');
    
    // Extract just the registry part (before the first /) in case user entered full image path
    const registryMatch = registryUrl.match(/^([^\/]+)/);
    if (registryMatch) {
      registryUrl = registryMatch[1];
    }

    // Validate ECR URL format
    if (!registryUrl.match(/^\d+\.dkr\.ecr\.[\w-]+\.amazonaws\.com$/)) {
      console.log(chalk.yellow(`   ⚠️  Invalid ECR registry URL format: ${registryUrl}`));
      console.log(chalk.cyan('   Expected format: {account-id}.dkr.ecr.{region}.amazonaws.com'));
      return;
    }

    // Get ECR login token (valid for 12 hours)
    const ecrPassword = execSync(
      `aws ecr get-login-password --region ${config.region}`,
      { encoding: 'utf-8', env: { ...process.env } }
    ).trim();

    if (!ecrPassword) {
      throw new Error('Failed to get ECR login password');
    }

    // Use kubectl create secret docker-registry (recommended method)
    try {
      // Delete existing secret if any (in case of update)
      execSync(
        `kubectl delete secret ${secretName} -n ${namespace} 2>/dev/null || true`,
        { stdio: 'pipe' }
      );

      // Create secret using kubectl command (most reliable)
      // Use environment variable to pass password to avoid shell escaping issues
      const envWithPassword = {
        ...process.env,
        ECR_PASSWORD: ecrPassword,
      };
      
      execSync(
        `kubectl create secret docker-registry ${secretName} ` +
        `--docker-server=${registryUrl} ` +
        `--docker-username=AWS ` +
        `--docker-password="$ECR_PASSWORD" ` +
        `--namespace=${namespace}`,
        { stdio: 'pipe', env: envWithPassword }
      );

      console.log(chalk.green(`   ✓ ECR ImagePullSecret created for ${registryUrl}`));
    } catch (createError: any) {
      // Fallback: Create secret using kubectl with --from-literal
      try {
        execSync(
          `kubectl delete secret ${secretName} -n ${namespace} 2>/dev/null || true`,
          { stdio: 'pipe' }
        );

        // Alternative: use --from-literal (may not work in all kubectl versions)
        execSync(
          `kubectl create secret docker-registry ${secretName} ` +
          `--docker-server=${registryUrl} ` +
          `--docker-username=AWS ` +
          `--docker-password="${ecrPassword.replace(/"/g, '\\"')}" ` +
          `--namespace=${namespace}`,
          { stdio: 'pipe', env: { ...process.env } }
        );

        console.log(chalk.green(`   ✓ ECR ImagePullSecret created (method 1)`));
      } catch (fallbackError: any) {
        // Final fallback: Manual YAML creation
        console.log(chalk.yellow(`   ⚠️  kubectl create secret failed, trying manual YAML method...`));
        
        const dockerConfig = {
          auths: {
            [registryUrl]: {
              username: 'AWS',
              password: ecrPassword,
              auth: Buffer.from(`AWS:${ecrPassword}`).toString('base64'),
            },
          },
        };

        const secretYaml = `apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: ${namespace}
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: ${Buffer.from(JSON.stringify(dockerConfig)).toString('base64')}
`;

        const tempFile = path.join(process.cwd(), '.temp-ecr-secret.yaml');
        await fs.writeFile(tempFile, secretYaml);
        execSync(`kubectl apply -f ${tempFile}`, { stdio: 'pipe' });
        await fs.remove(tempFile);

        console.log(chalk.green(`   ✓ ECR ImagePullSecret created (manual YAML method)`));
      }
    }
  } catch (error: any) {
    console.log(chalk.yellow(`   ⚠️  Could not create ECR ImagePullSecret: ${error.message}`));
    console.log(chalk.cyan('   Note: EKS nodes typically have IAM role with AmazonEC2ContainerRegistryReadOnly policy'));
    console.log(chalk.cyan('   If your nodes have this policy, ImagePullSecret may not be needed'));
    console.log(chalk.cyan('   However, some setups still require ImagePullSecret for pod-level authentication'));
    console.log(chalk.cyan('   The deployment will continue - if image pull fails, check node IAM permissions'));
  }
}

export async function validateImageExists(config: DeployConfig, imageUri: string): Promise<boolean> {
  if (!config.imageRegistry) {
    return true; // Local image, assume exists
  }

  if (config.imageRegistry.includes('amazonaws.com')) {
    // Check ECR
    try {
      const imageName = config.appName.toLowerCase();
      const repoName = imageName;
      const registryId = config.imageRegistry.split('.')[0];

      // Try to describe the image
      execSync(
        `aws ecr describe-images --repository-name ${repoName} --image-ids imageTag=latest --region ${config.region} 2>/dev/null`,
        { encoding: 'utf-8', stdio: 'pipe', env: { ...process.env } }
      );
      return true;
    } catch (error) {
      console.log(chalk.yellow(`   ⚠️  Image ${imageUri} not found in ECR`));
      console.log(chalk.cyan(`   Make sure the image was pushed successfully`));
      return false;
    }
  } else {
    // Docker Hub or other registry - assume exists if we got here
    return true;
  }
}

export async function checkAndFixImagePullError(config: DeployConfig): Promise<void> {
  const namespace = config.namespace || 'default';

  try {
    const pods = execSync(
      `kubectl get pods -n ${namespace} -l app=${config.appName} -o json`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    const podsData = JSON.parse(pods);

    if (!podsData.items || podsData.items.length === 0) {
      return;
    }

    for (const pod of podsData.items) {
      const containerStatuses = pod.status?.containerStatuses || [];
      for (const status of containerStatuses) {
        const waiting = status.state?.waiting;
        if (waiting && (waiting.reason === 'ImagePullBackOff' || waiting.reason === 'ErrImagePull')) {
          console.log(chalk.yellow(`\n   ⚠️  Detected ImagePullBackOff error for pod ${pod.metadata.name}`));

          // Check if it's ECR and we need to setup ImagePullSecret
          if (config.imageRegistry && config.imageRegistry.includes('amazonaws.com')) {
            console.log(chalk.blue('   Setting up ECR ImagePullSecret...'));
            await setupECRImagePullSecret(config);

            // Delete the pod to force recreation with new secret
            console.log(chalk.blue(`   Deleting pod ${pod.metadata.name} to retry with ImagePullSecret...`));
            execSync(`kubectl delete pod ${pod.metadata.name} -n ${namespace}`, { stdio: 'pipe' });
            console.log(chalk.green('   ✓ Pod deleted, will be recreated with ImagePullSecret'));
          } else {
            // Check for platform mismatch error
            const errorMessage = waiting.message || '';
            if (errorMessage.includes('no match for platform') || errorMessage.includes('platform')) {
              console.log(chalk.red('   ❌ Platform mismatch detected!'));
              console.log(chalk.yellow('   Your image was built for a different platform than EKS nodes'));
              console.log(chalk.cyan('   Solution: Rebuild image for linux/amd64:'));
              console.log(chalk.white('      docker buildx build --platform linux/amd64 -t <image> --load .'));
              console.log(chalk.white('      docker push <image>'));
            } else {
              console.log(chalk.yellow('   ⚠️  Image pull failed. Possible causes:'));
              console.log(chalk.white('      1. Image does not exist in registry'));
              console.log(chalk.white('      2. Registry requires authentication (ImagePullSecret needed)'));
              console.log(chalk.white('      3. Platform mismatch (image built for wrong architecture)'));
              console.log(chalk.white('      4. Network issues preventing image pull'));
            }
          }
        }
      }
    }
  } catch (error) {
    // Ignore errors in checking
  }
}

export async function buildAndPushImage(config: DeployConfig): Promise<string | null> {
  const imageName = config.appName.toLowerCase();
  let imageUri: string;
  const artifactDir = config.artifactDir || process.cwd();
  const dockerfilePath = path.join(artifactDir, 'Dockerfile');
  const buildContext = process.cwd();

  if (config.imageRegistry) {
    if (config.imageRegistry.includes('amazonaws.com')) {
      imageUri = `${config.imageRegistry}/${imageName}:latest`;

      try {
        const loginCommand = execSync(
          `aws ecr get-login-password --region ${config.region}`,
          { encoding: 'utf-8', env: { ...process.env } }
        );
        execSync(
          `echo "${loginCommand}" | docker login --username AWS --password-stdin ${config.imageRegistry}`,
          { stdio: 'inherit' }
        );
      } catch (error) {
        console.log(chalk.yellow('   ⚠️  Could not login to ECR, skipping image push'));
        return null;
      }
    } else {
      imageUri = `${config.imageRegistry}/${imageName}:latest`;
      console.log(chalk.yellow('   ⚠️  Please ensure Docker Hub credentials are configured'));
    }
  } else {
    imageUri = `${imageName}:latest`;
    console.log(chalk.yellow('   ⚠️  No registry specified, using local image'));
    console.log(chalk.yellow('   ⚠️  You may need to push the image manually or use a local registry'));
    return null;
  }

  console.log(chalk.blue(`   Building image: ${imageUri}`));
  
  // Detect if we're on ARM (Apple Silicon) and EKS nodes are likely amd64
  // Build for linux/amd64 platform to ensure compatibility with EKS nodes
  let buildCommand = `docker build -f "${dockerfilePath}" -t ${imageUri} ${buildContext}`;
  
  try {
    // Check if docker buildx is available (for multi-platform builds)
    execSync(`docker buildx version`, { stdio: 'pipe' });
    
    // Use buildx to build for linux/amd64 platform (EKS standard)
    console.log(chalk.cyan('   Building for linux/amd64 platform (EKS compatible)...'));
    buildCommand = `docker buildx build --platform linux/amd64 -f "${dockerfilePath}" -t ${imageUri} --load ${buildContext}`;
  } catch (buildxError) {
    // buildx not available, try with --platform flag (requires Docker 20.10+)
    try {
      execSync(`docker build --help | grep -q platform || echo "no-platform"`, { stdio: 'pipe' });
      console.log(chalk.cyan('   Building for linux/amd64 platform (EKS compatible)...'));
      buildCommand = `docker build --platform linux/amd64 -f "${dockerfilePath}" -t ${imageUri} ${buildContext}`;
    } catch (platformError) {
      // Fallback to regular build (may fail on ARM Macs with amd64 EKS)
      console.log(chalk.yellow('   ⚠️  Building without platform specification'));
      console.log(chalk.yellow('   ⚠️  If you\'re on ARM Mac and EKS nodes are amd64, this may fail'));
      buildCommand = `docker build -f "${dockerfilePath}" -t ${imageUri} ${buildContext}`;
    }
  }
  
  try {
    execSync(buildCommand, { stdio: 'inherit' });
  } catch (error: any) {
    // If build fails and we're on ARM, suggest using buildx
    if (error.message.includes('platform') || error.message.includes('exec format')) {
      console.log(chalk.red(`\n   ❌ Build failed due to platform mismatch`));
      console.log(chalk.yellow('   💡 Solution: Install Docker Buildx and rebuild:'));
      console.log(chalk.cyan('      docker buildx create --use'));
      console.log(chalk.cyan(`      docker buildx build --platform linux/amd64 -t ${imageUri} --load .`));
    }
    throw new Error(`Failed to build Docker image: ${error.message}`);
  }

  if (config.imageRegistry) {
    console.log(chalk.blue(`   Pushing image: ${imageUri}`));
    try {
      execSync(`docker push ${imageUri}`, { stdio: 'inherit' });
      console.log(chalk.green(`   ✓ Image pushed successfully`));

      // Validate image exists after push
      const exists = await validateImageExists(config, imageUri);
      if (!exists) {
        console.log(chalk.yellow('   ⚠️  Image validation failed, but continuing...'));
      }
    } catch (error: any) {
      console.log(chalk.yellow(`   ⚠️  Failed to push image: ${error.message}`));
      console.log(chalk.yellow('   Continuing with local image...'));
      return null;
    }
  }

  return imageUri;
}

export async function setupDomain(config: DeployConfig): Promise<string | null> {
  if (!config.domain) {
    return null;
  }

  const hostname = config.domain.subdomain
    ? `${config.domain.subdomain}.${config.domain.domain}`
    : config.domain.domain;

  let certificateARN = config.domain.certificateARN;

  if (config.domain.enableSSL && !certificateARN) {
    console.log(chalk.blue(`   Requesting SSL certificate for ${hostname}...`));

    // ALB requires certificate in the same region as the cluster
    // Use cluster region instead of hardcoded us-east-1
    const acmClient = new ACMClient({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });

    try {
      const listCertsCommand = new ListCertificatesCommand({});
      const existingCerts = await acmClient.send(listCertsCommand);

      const existingCert = existingCerts.CertificateSummaryList?.find(
        cert => cert.DomainName === hostname || cert.DomainName === config.domain?.domain
      );

      if (existingCert?.CertificateArn) {
        certificateARN = existingCert.CertificateArn;
        console.log(chalk.green(`   ✓ Using existing certificate: ${certificateARN}`));
        
        // Check certificate status
        try {
          const describeCert = new DescribeCertificateCommand({ CertificateArn: certificateARN });
          const certDetails = await acmClient.send(describeCert);
          const status = certDetails.Certificate?.Status;
          
          if (status === 'PENDING_VALIDATION') {
            console.log(chalk.yellow(`   ⚠️  Certificate is pending validation`));
            if (config.domain.cloudflareApiToken && config.domain.cloudflareZoneId) {
              console.log(chalk.blue(`   Setting up certificate validation via Cloudflare...`));
              await setupCertificateValidation(config, certificateARN, acmClient);
            }
          } else if (status === 'ISSUED') {
            console.log(chalk.green(`   ✓ Certificate is validated and ready to use`));
          } else {
            console.log(chalk.yellow(`   ⚠️  Certificate status: ${status}`));
          }
        } catch (e) {
          // Ignore errors checking certificate status
        }
      } else {
        const certificateCommand = new RequestCertificateCommand({
          DomainName: hostname,
          ValidationMethod: 'DNS',
          SubjectAlternativeNames: config.domain.domain === hostname ? [] : [config.domain.domain],
        });

        const certResponse = await acmClient.send(certificateCommand);
        certificateARN = certResponse.CertificateArn || undefined;

        if (certificateARN) {
          console.log(chalk.green(`   ✓ Certificate requested: ${certificateARN}`));
          if (config.domain.cloudflareApiToken && config.domain.cloudflareZoneId) {
            console.log(chalk.blue(`   Setting up certificate validation via Cloudflare...`));
            await setupCertificateValidation(config, certificateARN, acmClient);
          } else {
            console.log(chalk.yellow(`   ⚠️  Certificate validation required. Check ACM console for DNS records.`));
          }
        }
      }
    } catch (error: any) {
      console.log(chalk.yellow(`   ⚠️  Could not request certificate: ${error.message}`));
    }
  }

  return certificateARN || null;
}

async function ensureCAAForACM(config: DeployConfig): Promise<void> {
  if (!config.domain || !config.domain.cloudflareApiToken || !config.domain.cloudflareZoneId) {
    return;
  }

  try {
    // Check if CAA records for ACM already exist
    const listResponse = await axios.get(
      `https://api.cloudflare.com/client/v4/zones/${config.domain.cloudflareZoneId}/dns_records?type=CAA&name=${config.domain.domain}`,
      {
        headers: {
          'Authorization': `Bearer ${config.domain.cloudflareApiToken}`,
        },
      }
    );

    const existingCAAs = listResponse.data.result || [];
    const hasAmazonCA = existingCAAs.some((r: any) => 
      r.content.includes('amazon.com') || r.content.includes('amazontrust.com')
    );

    if (!hasAmazonCA) {
      console.log(chalk.blue(`   Setting up CAA records for ACM...`));
      
      // Add CAA records for Amazon/ACM
      const caaRecords = [
        { tag: 'issue', value: 'amazon.com' },
        { tag: 'issuewild', value: 'amazon.com' },
        { tag: 'issue', value: 'amazontrust.com' },
        { tag: 'issuewild', value: 'amazontrust.com' },
      ];

      for (const caa of caaRecords) {
        try {
          await axios.post(
            `https://api.cloudflare.com/client/v4/zones/${config.domain.cloudflareZoneId}/dns_records`,
            {
              type: 'CAA',
              name: config.domain.domain,
              data: {
                flags: 0,
                tag: caa.tag,
                value: caa.value,
              },
              ttl: 120,
            },
            {
              headers: {
                'Authorization': `Bearer ${config.domain.cloudflareApiToken}`,
                'Content-Type': 'application/json',
              },
            }
          );
        } catch (error: any) {
          if (error.response?.data?.errors?.[0]?.code !== 81053) {
            // Ignore "already exists" errors
            console.log(chalk.yellow(`   ⚠️  Could not create CAA record: ${error.message}`));
          }
        }
      }
      console.log(chalk.green(`   ✓ CAA records configured for ACM`));
    }
  } catch (error: any) {
    console.log(chalk.yellow(`   ⚠️  Could not check/setup CAA records: ${error.message}`));
  }
}

async function setupCertificateValidation(config: DeployConfig, certificateARN: string, acmClient: ACMClient): Promise<void> {
  try {
    const describeCert = new DescribeCertificateCommand({ CertificateArn: certificateARN });
    const certDetails = await acmClient.send(describeCert);

    if (certDetails.Certificate?.DomainValidationOptions) {
      for (const validation of certDetails.Certificate.DomainValidationOptions) {
        if (validation.ResourceRecord) {
          try {
            // Extract record name (remove domain suffix)
            const fullName = validation.ResourceRecord.Name || '';
            const recordName = fullName.replace(`.${config.domain?.domain}`, '').replace(/\.$/, '');
            
            await axios.post(
              `https://api.cloudflare.com/client/v4/zones/${config.domain?.cloudflareZoneId}/dns_records`,
              {
                type: validation.ResourceRecord.Type,
                name: recordName,
                content: validation.ResourceRecord.Value,
                ttl: 300,
              },
              {
                headers: {
                  'Authorization': `Bearer ${config.domain?.cloudflareApiToken}`,
                  'Content-Type': 'application/json',
                },
              }
            );
            console.log(chalk.green(`   ✓ Certificate validation DNS record created: ${recordName}`));
          } catch (error: any) {
            if (error.response?.data?.errors?.[0]?.code === 81057) {
              // Record already exists, try to update
              try {
                const fullName = validation.ResourceRecord.Name || '';
                const recordName = fullName.replace(`.${config.domain?.domain}`, '').replace(/\.$/, '');
                
                const listResponse = await axios.get(
                  `https://api.cloudflare.com/client/v4/zones/${config.domain?.cloudflareZoneId}/dns_records?name=${validation.ResourceRecord.Name}`,
                  {
                    headers: {
                      'Authorization': `Bearer ${config.domain?.cloudflareApiToken}`,
                    },
                  }
                );
                if (listResponse.data.result && listResponse.data.result.length > 0) {
                  const recordId = listResponse.data.result[0].id;
                  await axios.put(
                    `https://api.cloudflare.com/client/v4/zones/${config.domain?.cloudflareZoneId}/dns_records/${recordId}`,
                    {
                      type: validation.ResourceRecord.Type,
                      name: recordName,
                      content: validation.ResourceRecord.Value,
                      ttl: 300,
                    },
                    {
                      headers: {
                        'Authorization': `Bearer ${config.domain?.cloudflareApiToken}`,
                        'Content-Type': 'application/json',
                      },
                    }
                  );
                  console.log(chalk.green(`   ✓ Certificate validation DNS record updated`));
                }
              } catch (updateError) {
                console.log(chalk.yellow(`   ⚠️  Could not update validation record: ${updateError}`));
              }
            } else {
              console.log(chalk.yellow(`   ⚠️  Could not create validation record: ${error.message}`));
              console.log(chalk.yellow(`   Please manually add DNS record: ${validation.ResourceRecord.Name} ${validation.ResourceRecord.Type} ${validation.ResourceRecord.Value}`));
            }
          }
        }
      }
    }
  } catch (error: any) {
    console.log(chalk.yellow(`   ⚠️  Could not auto-validate certificate: ${error.message}`));
    console.log(chalk.yellow(`   Please validate the certificate manually in ACM console`));
  }
}

async function checkWebhookReady(): Promise<boolean> {
  try {
    const podReady = await checkALBPodReady();
    const deploymentReady = await checkALBDeploymentReady();

    if (!podReady || !deploymentReady) {
      return false;
    }

    const endpointsResult = execSync(
      `kubectl get endpoints aws-load-balancer-webhook-service -n kube-system -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null || echo ""`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    return endpointsResult.trim() !== '';
  } catch (error) {
    return false;
  }
}

async function applyWithRetry(command: string, maxRetries: number = 10, maxWaitPerRetry: number = 60): Promise<void> {
  const startTime = Date.now();
  const maxTotalWait = 300;

  for (let i = 0; i < maxRetries; i++) {
    try {
      execSync(command, { stdio: 'inherit' });
      return;
    } catch (error: any) {
      const errorMessage = error.message || error.stdout?.toString() || error.stderr?.toString() || '';
      const totalElapsed = Math.floor((Date.now() - startTime) / 1000);

      if (errorMessage.includes('no endpoints available for service "aws-load-balancer-webhook-service"')) {
        if (i < maxRetries - 1 && totalElapsed < maxTotalWait) {
          console.log(chalk.yellow(`   ⚠️  Webhook not ready: ${errorMessage}`));
          console.log(chalk.yellow(`   Waiting... (attempt ${i + 1}/${maxRetries}, ${totalElapsed}s/${maxTotalWait}s total)`));

          let webhookReady = false;
          const waitStartTime = Date.now();

          for (let j = 0; j < Math.floor(maxWaitPerRetry / 3); j++) {
            const waitElapsed = Math.floor((Date.now() - waitStartTime) / 1000);

            if (totalElapsed + waitElapsed >= maxTotalWait) {
              console.log(chalk.yellow(`   Max total wait time reached (${maxTotalWait}s), retrying anyway...`));
              break;
            }

            webhookReady = await checkWebhookReady();
            if (webhookReady) {
              console.log(chalk.green('   ✓ Webhook is ready, retrying apply...'));
              await new Promise(resolve => setTimeout(resolve, 2000));
              break;
            }

            if (j % 3 === 0 && j > 0) {
              console.log(chalk.yellow(`   Still waiting for webhook... (${waitElapsed}s/${maxWaitPerRetry}s this retry)`));
            }

            await new Promise(resolve => setTimeout(resolve, 3000));
          }

          if (!webhookReady) {
            const waitElapsed = Math.floor((Date.now() - waitStartTime) / 1000);
            if (waitElapsed < maxWaitPerRetry) {
              console.log(chalk.yellow(`   Webhook not ready after ${waitElapsed}s, retrying anyway...`));
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        } else {
          console.log(chalk.red(`   ✗ Webhook service not ready after ${totalElapsed}s and ${i + 1} retries.`));
          await showALBDiagnostics();
          console.log(chalk.yellow('\n   ⚠️  This may be a temporary issue. You can:'));
          console.log(chalk.cyan('   1. Wait a few minutes and run the deployment again'));
          console.log(chalk.cyan('   2. Check ALB Controller status manually:'));
          console.log(chalk.cyan('      kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller'));
          console.log(chalk.cyan('      kubectl get endpoints -n kube-system aws-load-balancer-webhook-service'));
          console.log(chalk.cyan('      kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller'));
          console.log(chalk.cyan('   3. Try applying the service manually:'));
          console.log(chalk.cyan(`      kubectl apply -f ${command.split(' ').pop()}`));
          throw new Error(`Webhook service not ready after ${totalElapsed}s. Please check ALB Controller diagnostics above and try again.`);
        }
      } else {
        throw error;
      }
    }
  }
}

export async function applyManifests(config: DeployConfig, manifestsDir: string): Promise<void> {
  try {
    if (config.namespace && config.namespace !== 'default') {
      try {
        execSync(`kubectl create namespace ${config.namespace}`, { stdio: 'pipe' });
      } catch (error) {
      }
    }

    if (config.secrets && Object.keys(config.secrets).length > 0) {
      const secretsFile = path.join(manifestsDir, 'secrets.yaml');
      if (fs.existsSync(secretsFile)) {
        execSync(`kubectl apply -f ${secretsFile}`, { stdio: 'inherit' });
      }
    }

    execSync(
      `kubectl apply -f ${path.join(manifestsDir, 'deployment.yaml')}`,
      { stdio: 'inherit' }
    );

    if (config.enableIngress) {
      await applyWithRetry(
        `kubectl apply -f ${path.join(manifestsDir, 'service.yaml')}`,
        15,
        10000
      );
    } else {
      execSync(
        `kubectl apply -f ${path.join(manifestsDir, 'service.yaml')}`,
        { stdio: 'inherit' }
      );
    }

    if (config.autoscaling && config.autoscaling.enabled) {
      const hpaFile = path.join(manifestsDir, 'hpa.yaml');
      if (fs.existsSync(hpaFile)) {
        execSync(`kubectl apply -f ${hpaFile}`, { stdio: 'inherit' });
      }
    }

    if (config.enableIngress) {
      await applyWithRetry(
        `kubectl apply -f ${path.join(manifestsDir, 'ingress.yaml')}`,
        15,
        10000
      );
    }
  } catch (error: any) {
    throw new Error(`Failed to apply manifests: ${error.message}`);
  }
}

// proxied defaults to true to auto-enable Cloudflare orange proxy once DNS is set
export async function setupCloudflareDNS(config: DeployConfig, target: string, proxied: boolean = true): Promise<void> {
  if (!config.domain || !config.domain.cloudflareApiToken || !config.domain.cloudflareZoneId) {
    return;
  }

  const hostname = config.domain.subdomain
    ? `${config.domain.subdomain}.${config.domain.domain}`
    : config.domain.domain;

  const recordName = config.domain.subdomain || config.domain.domain;

  console.log(chalk.blue(`   Setting up Cloudflare CNAME record for ${hostname}...`));

  try {
    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/zones/${config.domain.cloudflareZoneId}/dns_records`,
      {
        type: 'CNAME',
        name: recordName,
        content: target,
        ttl: 1,
        proxied,
      },
      {
        headers: {
          'Authorization': `Bearer ${config.domain.cloudflareApiToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data.success) {
      console.log(chalk.green(`   ✓ Cloudflare CNAME record created: ${hostname} -> ${target}`));
      console.log(chalk.green(`   ✓ Your domain is now pointing to your application!`));
    } else {
      throw new Error(response.data.errors?.[0]?.message || 'Failed to create DNS record');
    }
  } catch (error: any) {
    if (error.response?.data?.errors?.[0]?.code === 81057) {
      console.log(chalk.yellow(`   ⚠️  DNS record already exists, updating...`));
      try {
        const listResponse = await axios.get(
          `https://api.cloudflare.com/client/v4/zones/${config.domain.cloudflareZoneId}/dns_records?name=${hostname}`,
          {
            headers: {
              'Authorization': `Bearer ${config.domain.cloudflareApiToken}`,
            },
          }
        );

        if (listResponse.data.result && listResponse.data.result.length > 0) {
          const recordId = listResponse.data.result[0].id;
          await axios.put(
            `https://api.cloudflare.com/client/v4/zones/${config.domain.cloudflareZoneId}/dns_records/${recordId}`,
            {
              type: 'CNAME',
              name: recordName,
              content: target,
              ttl: 1,
              proxied,
            },
            {
              headers: {
                'Authorization': `Bearer ${config.domain.cloudflareApiToken}`,
                'Content-Type': 'application/json',
              },
            }
          );
          console.log(chalk.green(`   ✓ Cloudflare CNAME record updated: ${hostname} -> ${target}`));
        }
      } catch (updateError: any) {
        console.log(chalk.yellow(`   ⚠️  Could not update DNS record: ${updateError.message}`));
      }
    } else {
      console.log(chalk.red(`   ✗ Failed to create Cloudflare DNS record: ${error.message}`));
      if (error.response?.data?.errors) {
        console.log(chalk.red(`   Error details: ${JSON.stringify(error.response.data.errors)}`));
      }
      console.log(chalk.yellow(`   Please manually create a CNAME record in Cloudflare:`));
      console.log(chalk.cyan(`   Name: ${recordName}`));
      console.log(chalk.cyan(`   Type: CNAME`));
      console.log(chalk.cyan(`   Target: ${target}`));
      console.log(chalk.cyan(`   Proxy: OFF`));
      throw error;
    }
  }
}

export async function waitForIngressAndSetupDNS(config: DeployConfig): Promise<string | null> {
  if (!config.domain) {
    return null;
  }

  console.log(chalk.yellow('\n⏳ Waiting for ALB to be provisioned (this may take 5-10 minutes)...'));

  let retries = 60;
  let albDNS: string | null = null;
  let certificateError = false;

  while (retries > 0 && !albDNS) {
    try {
      const ingressInfo = execSync(
        `kubectl get ingress ${config.appName}-ingress -n ${config.namespace || 'default'} -o json`,
        { encoding: 'utf-8', stdio: 'pipe' }
      );

      const ingress = JSON.parse(ingressInfo);
      if (ingress.status?.loadBalancer?.ingress?.[0]?.hostname) {
        albDNS = ingress.status.loadBalancer.ingress[0].hostname;
        break;
      }

      // Check for certificate errors
      try {
        const events = execSync(
          `kubectl get events -n ${config.namespace || 'default'} --field-selector involvedObject.name=${config.appName}-ingress --sort-by='.lastTimestamp' -o json 2>/dev/null || echo "{}"`,
          { encoding: 'utf-8', stdio: 'pipe' }
        );
        const eventsData = JSON.parse(events);
        const failedEvents = eventsData.items?.filter((e: any) => 
          e.type === 'Warning' && 
          (e.reason === 'FailedDeployModel' || e.reason === 'FailedBuildModel') &&
          e.message?.includes('Certificate')
        );
        
        if (failedEvents && failedEvents.length > 0) {
          const lastError = failedEvents[failedEvents.length - 1];
          if (lastError.message?.includes('Certificate ARN') || lastError.message?.includes('UnsupportedCertificate')) {
            certificateError = true;
            console.log(chalk.red('\n   ❌ Certificate Error Detected!'));
            console.log(chalk.yellow('   The certificate specified in ingress is invalid or in wrong region.'));
            console.log(chalk.cyan('   Attempting to fix by removing invalid certificate annotation...'));
            
            // Remove certificate annotation temporarily to allow ALB creation
            try {
              execSync(
                `kubectl annotate ingress ${config.appName}-ingress -n ${config.namespace || 'default'} alb.ingress.kubernetes.io/certificate-arn- --overwrite`,
                { stdio: 'pipe' }
              );
              execSync(
                `kubectl annotate ingress ${config.appName}-ingress -n ${config.namespace || 'default'} alb.ingress.kubernetes.io/ssl-redirect- --overwrite`,
                { stdio: 'pipe' }
              );
              console.log(chalk.green('   ✓ Removed invalid certificate annotation'));
              console.log(chalk.cyan('   ALB will be created without SSL. You can add certificate later.'));
              // Reset retries to wait for ALB without certificate
              retries = 30;
            } catch (e) {
              console.log(chalk.yellow('   ⚠️  Could not remove certificate annotation automatically'));
            }
          }
        }
      } catch (e) {
        // Ignore errors checking events
      }
    } catch (error) {
    }

    process.stdout.write('.');
    await new Promise(resolve => setTimeout(resolve, 10000));
    retries--;
  }

  console.log('');

  if (!albDNS) {
    console.log(chalk.yellow('   ⚠️  ALB is still being provisioned. This can take 5-10 minutes.'));
    console.log(chalk.cyan(`   Check status: kubectl get ingress ${config.appName}-ingress -n ${config.namespace || 'default'}`));
    
    // Check if there are IAM permission issues
    try {
      const ingressEvents = execSync(
        `kubectl get events -n ${config.namespace || 'default'} --field-selector involvedObject.name=${config.appName}-ingress --sort-by='.lastTimestamp' -o json 2>/dev/null || echo "{}"`,
        { encoding: 'utf-8', stdio: 'pipe' }
      );
      const events = JSON.parse(ingressEvents);
      const failedEvents = events.items?.filter((e: any) => e.type === 'Warning' && e.reason === 'FailedBuildModel');
      if (failedEvents && failedEvents.length > 0) {
        const lastError = failedEvents[failedEvents.length - 1];
        if (lastError.message?.includes('UnauthorizedOperation') || lastError.message?.includes('not authorized')) {
          console.log(chalk.red('\n   ❌ ALB Controller IAM Permission Issue Detected!'));
          console.log(chalk.yellow('   The ALB Controller service account needs additional IAM permissions.'));
          console.log(chalk.cyan('   Fix: Add the following policy to your ALB Controller IAM role:'));
          console.log(chalk.white('      - ec2:DescribeAvailabilityZones'));
          console.log(chalk.white('      - ec2:DescribeSubnets'));
          console.log(chalk.white('      - ec2:DescribeVpcs'));
          console.log(chalk.cyan('   Or use eksctl to update: eksctl utils associate-iam-oidc-provider --cluster <cluster-name>'));
        }
      }
    } catch (e) {
      // Ignore errors checking events
    }
    
    console.log(chalk.cyan(`   Once ALB is ready, DNS will be automatically configured.`));
    console.log(chalk.cyan(`   Or manually run: ekspressjs setup-dns`));
    return null;
  }

  console.log(chalk.green(`   ✓ ALB DNS: ${albDNS}`));
  
  // Check certificate status and enable SSL redirect if validated
  if (config.domain && config.domain.enableSSL && config.domain.certificateARN) {
    try {
      const acmClient = new ACMClient({
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
      const describeCert = new DescribeCertificateCommand({ CertificateArn: config.domain.certificateARN });
      const certDetails = await acmClient.send(describeCert);
      const status = certDetails.Certificate?.Status;
      
      if (status === 'ISSUED') {
          console.log(chalk.green(`   ✓ Certificate is validated, enabling HTTPS...`));
        try {
          // Add HTTPS listener and certificate
          execSync(
            `kubectl annotate ingress ${config.appName}-ingress -n ${config.namespace || 'default'} alb.ingress.kubernetes.io/listen-ports='[{"HTTP": 80}, {"HTTPS": 443}]' --overwrite`,
            { stdio: 'pipe' }
          );
          execSync(
            `kubectl annotate ingress ${config.appName}-ingress -n ${config.namespace || 'default'} alb.ingress.kubernetes.io/certificate-arn='${config.domain.certificateARN}' --overwrite`,
            { stdio: 'pipe' }
          );
          execSync(
            `kubectl annotate ingress ${config.appName}-ingress -n ${config.namespace || 'default'} alb.ingress.kubernetes.io/ssl-redirect='443' --overwrite`,
            { stdio: 'pipe' }
          );
          console.log(chalk.green(`   ✓ HTTPS enabled with SSL redirect`));
          console.log(chalk.cyan(`   ALB Controller will update the listener. This may take 2-3 minutes.`));
            // Switch Cloudflare to proxied (orange) once HTTPS is ready
            if (albDNS) {
              await setupCloudflareDNS(config, albDNS, true);
            }
        } catch (e) {
          console.log(chalk.yellow(`   ⚠️  Could not enable HTTPS automatically`));
        }
      } else if (status === 'PENDING_VALIDATION') {
        console.log(chalk.yellow(`   ⚠️  Certificate is pending validation. Setting up validation and waiting...`));
        if (config.domain.cloudflareApiToken && config.domain.cloudflareZoneId) {
          console.log(chalk.blue(`   Setting up certificate validation DNS records...`));
          await setupCertificateValidation(config, config.domain.certificateARN, acmClient);
          
          // Wait for certificate validation automatically
          console.log(chalk.cyan(`   Waiting for certificate validation (this may take 5-10 minutes)...`));
          let validated = false;
          let waitRetries = 60; // 10 minutes max
          
          while (waitRetries > 0 && !validated) {
            await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
            
            const checkCert = new DescribeCertificateCommand({ CertificateArn: config.domain.certificateARN });
            const certStatus = await acmClient.send(checkCert);
            const certStatusValue = certStatus.Certificate?.Status;
            
            if (certStatusValue === 'ISSUED') {
              validated = true;
              console.log(chalk.green(`   ✓ Certificate validated successfully!`));
              
              // Enable HTTPS
              console.log(chalk.blue(`   Enabling HTTPS...`));
              execSync(
                `kubectl annotate ingress ${config.appName}-ingress -n ${config.namespace || 'default'} alb.ingress.kubernetes.io/listen-ports='[{"HTTP": 80}, {"HTTPS": 443}]' --overwrite`,
                { stdio: 'pipe' }
              );
              execSync(
                `kubectl annotate ingress ${config.appName}-ingress -n ${config.namespace || 'default'} alb.ingress.kubernetes.io/certificate-arn='${config.domain.certificateARN}' --overwrite`,
                { stdio: 'pipe' }
              );
              execSync(
                `kubectl annotate ingress ${config.appName}-ingress -n ${config.namespace || 'default'} alb.ingress.kubernetes.io/ssl-redirect='443' --overwrite`,
                { stdio: 'pipe' }
              );
              console.log(chalk.green(`   ✓ HTTPS enabled with SSL redirect`));
              console.log(chalk.cyan(`   ALB Controller will update the listener. This may take 2-3 minutes.`));
              break;
            } else if (certStatusValue === 'FAILED' || certStatusValue === 'VALIDATION_TIMED_OUT') {
              console.log(chalk.red(`   ✗ Certificate validation failed. Status: ${certStatusValue}`));
              console.log(chalk.yellow(`   Will attempt to request new certificate...`));
              // Fall through to FAILED handling
              break;
            }
            
            waitRetries--;
            if (waitRetries % 6 === 0) {
              process.stdout.write('.');
            }
          }
          
          if (!validated) {
            console.log(chalk.yellow(`\n   ⚠️  Certificate validation is taking longer than expected.`));
            console.log(chalk.cyan(`   Certificate ARN: ${config.domain.certificateARN}`));
            console.log(chalk.cyan(`   HTTPS will be enabled automatically once validation completes.`));
            console.log(chalk.cyan(`   You can check status: aws acm describe-certificate --certificate-arn ${config.domain.certificateARN} --region ${config.region}`));
          }
        } else {
          console.log(chalk.yellow(`   ⚠️  Cloudflare credentials not available. Cannot auto-validate certificate.`));
          console.log(chalk.cyan(`   Please manually validate certificate in ACM console`));
        }
      } else if (status === 'VALIDATION_TIMED_OUT' || status === 'FAILED') {
        console.log(chalk.yellow(`   ⚠️  Certificate ${status.toLowerCase()}. Auto-requesting new certificate...`));
        
        try {
          // Auto-request new certificate
          const hostname = config.domain.subdomain
            ? `${config.domain.subdomain}.${config.domain.domain}`
            : config.domain.domain;
          
          console.log(chalk.blue(`   Requesting new ACM certificate for ${hostname}...`));
          
          // Check and setup CAA records if needed
          await ensureCAAForACM(config);
          
          const requestCertCommand = new RequestCertificateCommand({
            DomainName: hostname,
            ValidationMethod: 'DNS',
            Options: {
              CertificateTransparencyLoggingPreference: 'ENABLED',
            },
            IdempotencyToken: `${config.appName}-${Date.now()}`,
          });
          
          const requestResult = await acmClient.send(requestCertCommand);
          const newCertificateARN = requestResult.CertificateArn;
          
          if (newCertificateARN) {
            console.log(chalk.green(`   ✓ New certificate requested: ${newCertificateARN}`));
            
            // Setup DNS validation automatically
            if (config.domain.cloudflareApiToken && config.domain.cloudflareZoneId) {
              console.log(chalk.blue(`   Setting up DNS validation records...`));
              await setupCertificateValidation(config, newCertificateARN, acmClient);
              
              // Wait for certificate validation (with timeout)
              console.log(chalk.cyan(`   Waiting for certificate validation (this may take 5-10 minutes)...`));
              let validated = false;
              let waitRetries = 60; // 10 minutes max
              
              while (waitRetries > 0 && !validated) {
                await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds
                
                const checkCert = new DescribeCertificateCommand({ CertificateArn: newCertificateARN });
                const certStatus = await acmClient.send(checkCert);
                const certStatusValue = certStatus.Certificate?.Status;
                
                if (certStatusValue === 'ISSUED') {
                  validated = true;
                  console.log(chalk.green(`   ✓ Certificate validated successfully!`));
                  
                  // Update config with new certificate ARN
                  config.domain.certificateARN = newCertificateARN;
                  
                  // Enable HTTPS
                  console.log(chalk.blue(`   Enabling HTTPS with new certificate...`));
                  execSync(
                    `kubectl annotate ingress ${config.appName}-ingress -n ${config.namespace || 'default'} alb.ingress.kubernetes.io/listen-ports='[{"HTTP": 80}, {"HTTPS": 443}]' --overwrite`,
                    { stdio: 'pipe' }
                  );
                  execSync(
                    `kubectl annotate ingress ${config.appName}-ingress -n ${config.namespace || 'default'} alb.ingress.kubernetes.io/certificate-arn='${newCertificateARN}' --overwrite`,
                    { stdio: 'pipe' }
                  );
                  execSync(
                    `kubectl annotate ingress ${config.appName}-ingress -n ${config.namespace || 'default'} alb.ingress.kubernetes.io/ssl-redirect='443' --overwrite`,
                    { stdio: 'pipe' }
                  );
                  console.log(chalk.green(`   ✓ HTTPS enabled with new certificate`));
                  console.log(chalk.cyan(`   ALB Controller will update the listener. This may take 2-3 minutes.`));
                  break;
                } else if (certStatusValue === 'FAILED' || certStatusValue === 'VALIDATION_TIMED_OUT') {
                  console.log(chalk.red(`   ✗ Certificate validation failed again. Status: ${certStatusValue}`));
                  break;
                }
                
                waitRetries--;
                if (waitRetries % 6 === 0) {
                  process.stdout.write('.');
                }
              }
              
              if (!validated) {
                console.log(chalk.yellow(`\n   ⚠️  Certificate validation is taking longer than expected.`));
                console.log(chalk.cyan(`   Certificate ARN: ${newCertificateARN}`));
                console.log(chalk.cyan(`   HTTPS will be enabled automatically once validation completes.`));
                console.log(chalk.cyan(`   You can check status: aws acm describe-certificate --certificate-arn ${newCertificateARN} --region ${config.region}`));
              }
            } else {
              console.log(chalk.yellow(`   ⚠️  Cloudflare credentials not available. Cannot auto-validate certificate.`));
              console.log(chalk.cyan(`   Please manually validate certificate: ${newCertificateARN}`));
            }
          }
        } catch (error: any) {
          console.log(chalk.yellow(`   ⚠️  Could not auto-request certificate: ${error.message}`));
          console.log(chalk.cyan(`   Please manually request certificate in ACM console`));
        }
      } else {
        console.log(chalk.yellow(`   ⚠️  Certificate status: ${status}. Using HTTP only for now.`));
        console.log(chalk.cyan(`   HTTPS will be enabled automatically once certificate is validated.`));
      }
    } catch (e) {
      console.log(chalk.yellow(`   ⚠️  Could not check certificate status`));
    }
  }
  
  console.log(chalk.blue(`   Setting up Cloudflare CNAME record...`));

  try {
    await setupCloudflareDNS(config, albDNS);
    console.log(chalk.green(`   ✓ DNS configuration completed!`));
    if (certificateError) {
      console.log(chalk.yellow(`   ⚠️  Note: ALB was created without SSL certificate due to certificate validation error.`));
      console.log(chalk.cyan(`   To add SSL later, request a certificate in region ${config.region} and update ingress annotation.`));
    }
    return albDNS;
  } catch (error: any) {
    console.log(chalk.yellow(`   ⚠️  Could not setup DNS automatically: ${error.message}`));
    console.log(chalk.cyan(`   You can manually create DNS record:`));
    const hostname = config.domain.subdomain
      ? `${config.domain.subdomain}.${config.domain.domain}`
      : config.domain.domain;
    console.log(chalk.white(`   Name: ${config.domain.subdomain || config.domain.domain}`));
    console.log(chalk.white(`   Type: CNAME`));
    console.log(chalk.white(`   Target: ${albDNS}`));
    return albDNS;
  }
}

export async function deleteCloudflareRecord(config: DeployConfig): Promise<void> {
  if (!config.domain || !config.domain.cloudflareApiToken || !config.domain.cloudflareZoneId) {
    return;
  }

  const hostname = config.domain.subdomain
    ? `${config.domain.subdomain}.${config.domain.domain}`
    : config.domain.domain;

  try {
    const listResponse = await axios.get(
      `https://api.cloudflare.com/client/v4/zones/${config.domain.cloudflareZoneId}/dns_records?name=${hostname}`,
      {
        headers: {
          'Authorization': `Bearer ${config.domain.cloudflareApiToken}`,
        },
      }
    );

    const records = listResponse.data.result || [];
    if (!records.length) {
      console.log(chalk.yellow(`   ⚠️  No Cloudflare DNS record found for ${hostname}`));
      return;
    }

    const recordId = records[0].id;
    await axios.delete(
      `https://api.cloudflare.com/client/v4/zones/${config.domain.cloudflareZoneId}/dns_records/${recordId}`,
      {
        headers: {
          'Authorization': `Bearer ${config.domain.cloudflareApiToken}`,
        },
      }
    );
    console.log(chalk.green(`   ✓ Cloudflare DNS record deleted: ${hostname}`));
  } catch (error: any) {
    console.log(chalk.yellow(`   ⚠️  Could not delete Cloudflare DNS record: ${error.message}`));
  }
}

