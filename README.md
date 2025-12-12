# EKSPressJS 🚀

Deploy applications to Amazon EKS quickly and easily with ready-to-use configurations.

## Features

- 🎯 One-command deployment to EKS
- 📦 Support for multiple frameworks (Next.js, Nuxt.js, Node.js, NestJS, React, Vue, etc.)
- ⚙️ Automatic Dockerfile generation
- ☸️ Kubernetes manifests generation
- 🔐 AWS configuration prompts
- 🚀 Ready-to-use configurations

## Installation

```bash
npm install -g ekspressjs
```

Or use with npx (no installation needed):

```bash
npx ekspressjs --app next
```

## Usage

### Basic Usage

```bash
npx ekspressjs --framework <framework-type>
```

Or use the shorter alias:

```bash
npx ekspressjs -f <framework-type>
```

### Supported Application Types

- `next` - Next.js applications
- `nuxt` - Nuxt.js applications
- `nest` - NestJS applications
- `react` - React applications (static)
- `vue` - Vue.js applications (static)

### Examples

```bash
# Deploy Next.js app
npx ekspressjs --framework next

# Deploy Nuxt.js app
npx ekspressjs --framework nuxt

# Deploy NestJS app
npx ekspressjs --framework nest
```

## Configuration

When you run the command, you'll be prompted to enter:

### Basic Configuration
1. **AWS Region** - Your EKS cluster region
2. **Cluster Name** - Name of your EKS cluster
3. **Application Name** - Name for your application
4. **Port** - Port your application runs on (default: 3000)
5. **Replicas** - Number of replicas (default: 2)
6. **Namespace** - Kubernetes namespace (default: default)
7. **Ingress** - Enable external access via ALB
8. **Image Registry** - ECR URI or Docker Hub username
9. **AWS Credentials** - Access Key ID and Secret Access Key

### Domain Configuration (Optional but Recommended)
- **Domain** - Your domain name (e.g., example.com)
- **Subdomain** - Optional subdomain (e.g., app)
- **SSL/TLS** - Enable HTTPS with automatic certificate provisioning
- **Cloudflare API Token** - Your Cloudflare API token (see below)
- **Cloudflare Zone ID** - Your Cloudflare zone ID (see below)

### Advanced Configuration
- **Resource Limits** - CPU and memory requests/limits
- **Autoscaling** - Horizontal Pod Autoscaler configuration
- **Environment Variables** - Custom environment variables
- **Secrets** - Kubernetes secrets for sensitive data
- **Health Check Path** - Custom health check endpoint
- **Metrics** - Enable metrics collection

## What It Does

1. ✅ **Auto-detects prerequisites** and guides installation if missing
2. ✅ **Auto-detects existing EKS clusters** or helps create new ones
3. ✅ Generates optimized Dockerfile for your app type
4. ✅ Creates Kubernetes deployment manifests with custom resources
5. ✅ Creates Kubernetes service manifests
6. ✅ Creates ingress configuration with domain and SSL
7. ✅ Automatically requests SSL certificate from ACM
8. ✅ Automatically configures Cloudflare DNS records
9. ✅ Builds Docker image
10. ✅ Pushes to ECR (or Docker Hub)
11. ✅ Deploys to EKS cluster
12. ✅ Sets up autoscaling (if enabled)
13. ✅ Configures secrets and environment variables
14. ✅ **Your app is accessible via domain immediately after deployment!**

## Requirements

- Node.js >= 20
- Docker installed and running
- kubectl installed (will be auto-detected)
- AWS CLI installed (will be auto-detected)
- EKS cluster (can be created automatically during deployment)
- AWS credentials (Access Key ID and Secret Access Key)

## Prerequisites

EKSPressJS will automatically detect and guide you through installing missing prerequisites. However, you can install them manually:

### Docker
- **macOS**: `brew install docker` or download [Docker Desktop](https://www.docker.com/products/docker-desktop)
- **Linux**: `sudo apt-get install docker.io` or follow [Docker installation guide](https://docs.docker.com/engine/install/)
- **Windows**: Download [Docker Desktop](https://www.docker.com/products/docker-desktop)

### kubectl
- **macOS**: `brew install kubectl`
- **Linux**: Follow [kubectl installation guide](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/)
- **Windows**: Follow [kubectl installation guide](https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/)

### AWS CLI
- **macOS**: `brew install awscli`
- **Linux**: `pip install awscli` or follow [AWS CLI installation guide](https://aws.amazon.com/cli/)
- **Windows**: Download from [AWS CLI](https://aws.amazon.com/cli/)

### Get AWS Credentials (Access Key & Secret)
- Option 1: Reuse existing AWS CLI config  
  - Run `aws configure` (if not done before)  
  - Provide Access Key, Secret Key, default region, output format  
- Option 2: Create a new IAM Access Key (AWS Console)  
  1. Open AWS Console → IAM → Users → Your user (or create a new programmatic user)  
  2. Go to **Security credentials** → **Create access key** → Choose “Command Line Interface (CLI)”  
  3. Copy **Access key ID** and **Secret access key** (store securely)  
- Permissions needed (least privilege): EKS, ECR (push/pull), ACM (request/describe), and Route53/Cloudflare DNS as used.

### EKS Cluster

**Option 1: Create automatically during deployment** (Recommended)
- EKSPressJS will prompt you to create a cluster if none exists
- Follow the interactive prompts to create your cluster

**Option 2: Create manually**
```bash
# Using eksctl (recommended)
eksctl create cluster --name my-cluster --region us-east-1

# Or using AWS Console
# Follow: https://docs.aws.amazon.com/eks/latest/userguide/create-cluster.html
```

## Configuration Notes

### Domain Setup

**For automatic domain access**, you need:
1. A domain registered (can be from any provider)
2. Route53 Hosted Zone created for your domain
3. Route53 Hosted Zone ID
4. Enable SSL/TLS in the prompts
5. AWS credentials with ACM and Route53 permissions
6. ALB Ingress Controller installed in your EKS cluster

**Cloudflare DNS Setup:**

EKSPressJS uses Cloudflare for automatic DNS management. You need:

1. **Cloudflare API Token**
   - Go to [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
   - Click **Create Token**
   - Use template **Edit zone DNS** or create custom token with:
     - **Zone** → **DNS** → **Edit** permission
   - Select your domain zone
   - Click **Continue to summary** → **Create Token**
   - **Copy the token immediately** (it's only shown once!)

2. **Cloudflare Zone ID**
   - Go to Cloudflare Dashboard
   - Select your domain
   - Scroll down to **API** section in the right sidebar
   - Copy the **Zone ID**

**During deployment, the tool will automatically:**
- Request SSL certificate from ACM (us-east-1)
- Create DNS validation records in Cloudflare
- Validate certificate automatically
- Create ALB Ingress with SSL
- Wait for ALB to be provisioned (2-5 minutes)
- Configure Cloudflare CNAME record pointing to ALB
- **Your app will be accessible at `https://your-domain.com` after deployment!**

📖 **See [CLOUDFLARE_SETUP.md](./CLOUDFLARE_SETUP.md) for detailed setup guide**

### Next.js
For optimal Docker builds, ensure your `next.config.js` includes:
```javascript
module.exports = {
  output: 'standalone',
  // ... other config
}
```

### Nuxt.js
Ensure your `nuxt.config.ts` is properly configured for production builds.

### NestJS
Ensure your NestJS app has a `build` script in `package.json` that compiles TypeScript to the `dist` folder. The default entry point is `dist/main.js`.

### Docker Registry
- **ECR**: Provide full ECR repository URI (e.g., `123456789.dkr.ecr.us-east-1.amazonaws.com`)
- **Docker Hub**: Provide your Docker Hub username
- **Local**: Leave empty to use local images (requires manual push or local registry)

## Generated Files & Layout

- All artifacts are placed under `./ekspressjs/` (keeps your project clean).
- If you already have a `Dockerfile` at project root, it is reused (copied into `./ekspressjs/Dockerfile`). Otherwise a Dockerfile is generated.
- Kubernetes manifests are written to:
  - `ekspressjs/k8s/deployment.yaml`
  - `ekspressjs/k8s/service.yaml`
  - `ekspressjs/k8s/ingress.yaml` (when ingress enabled)

## Troubleshooting

### Docker Build Fails
- Ensure Docker is running: `docker ps`
- Check Dockerfile syntax
- Verify all dependencies are in package.json

### kubectl Connection Fails
- Verify AWS credentials are correct
- Check cluster name and region
- Run: `aws eks update-kubeconfig --region <region> --name <cluster-name>`

### Image Push Fails
- For ECR: Ensure repository exists and IAM permissions are correct
- For Docker Hub: Ensure you're logged in: `docker login`

### Deployment Stuck
- Check pod status: `kubectl get pods -n <namespace>`
- View logs: `kubectl logs <pod-name> -n <namespace>`
- Check events: `kubectl describe pod <pod-name> -n <namespace>`

## Examples

### Deploy Next.js App
```bash
cd my-nextjs-app
npx ekspressjs --app next
```

### Deploy with Custom Port
```bash
npx ekspressjs --framework nest --port 8080
```

### Deploy with Custom Replicas
```bash
npx ekspressjs --framework nest --replicas 5
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

