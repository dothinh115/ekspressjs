# Example Usage

## Quick Start Example

### 1. Deploy a Next.js Application

```bash
# Navigate to your Next.js project
cd my-nextjs-app

# Run ekspressjs
npx ekspressjs --framework next

# Follow the prompts:
# - AWS Region: us-east-1
# - EKS Cluster Name: my-cluster
# - Application Name: my-nextjs-app
# - Port: 3000
# - Replicas: 2
# - Namespace: default
# - Enable Ingress: Yes
# - Image Registry: 123456789.dkr.ecr.us-east-1.amazonaws.com
# - AWS Access Key ID: AKIA...
# - AWS Secret Access Key: ...
```

### 2. Deploy a NestJS Application

```bash
cd my-nestjs-app
npx ekspressjs --framework nest --port 8080 --replicas 3
```

### 3. Deploy a NestJS Application

```bash
cd my-nestjs-app
npx ekspressjs --framework nest --port 8080 --replicas 3
```

### 3. Deploy a Nuxt.js Application

```bash
cd my-nuxt-app
npx ekspressjs --app nuxt --name my-nuxt-app
```

## What Happens During Deployment

1. **Prerequisites Check**: Verifies Docker, kubectl, and AWS CLI are installed
2. **Dockerfile Generation**: Creates optimized Dockerfile for your app type
3. **Kubernetes Manifests**: Generates deployment, service, and ingress manifests
4. **AWS Configuration**: Configures AWS credentials and kubectl
5. **Docker Build**: Builds your Docker image
6. **Image Push**: Pushes image to registry (ECR or Docker Hub)
7. **Kubernetes Deployment**: Applies manifests to your EKS cluster
8. **Status Check**: Waits for deployment to be ready

## Generated Files

After running the command, you'll find:

```
your-project/
├── Dockerfile              # Generated Dockerfile
└── k8s/
    ├── deployment.yaml     # Kubernetes deployment
    ├── service.yaml        # Kubernetes service
    └── ingress.yaml        # Kubernetes ingress (if enabled)
```

## Post-Deployment

### Check Deployment Status

```bash
kubectl get deployments -n default
kubectl get pods -n default
kubectl get services -n default
```

### View Logs

```bash
kubectl logs -f deployment/my-app -n default
```

### Access Your Application

If ingress is enabled, get the ALB address:

```bash
kubectl get ingress -n default
```

Then update your DNS to point to the ALB address.

## Troubleshooting

### Check Pod Status

```bash
kubectl describe pod <pod-name> -n default
```

### View Events

```bash
kubectl get events -n default --sort-by='.lastTimestamp'
```

### Delete Deployment

```bash
kubectl delete deployment my-app -n default
kubectl delete service my-app-service -n default
kubectl delete ingress my-app-ingress -n default
```

