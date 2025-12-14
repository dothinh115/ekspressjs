import { AppType } from '../types';
import { AWSConfig } from '../prompts';

export function generateDeploymentManifest(config: AWSConfig, appType: AppType): string {
  const imageName = config.imageRegistry
    ? `${config.imageRegistry}/${config.appName}:latest`
    : `${config.appName}:latest`;

  const port = appType === 'react' || appType === 'vue' ? 80 : config.port;
  const healthPath = config.healthCheckPath || '/';

  // Only set NODE_ENV for Node.js apps
  const isNodeApp = ['next', 'nuxt', 'nest', 'react', 'vue'].includes(appType);
  
  let envSection = `        env:
        - name: PORT
          value: "${port}"`;
  
  if (isNodeApp) {
    envSection += `
        - name: NODE_ENV
          value: "production"`;
  }

  if (config.envVars && config.envVars.length > 0) {
    for (const envVar of config.envVars) {
      if (envVar.fromSecret && envVar.secretKey) {
        envSection += `
        - name: ${envVar.name}
          valueFrom:
            secretKeyRef:
              name: ${config.appName}-secrets
              key: ${envVar.secretKey}`;
      } else {
        envSection += `
        - name: ${envVar.name}
          value: "${envVar.value}"`;
      }
    }
  }

  const resources = config.resources || {
    requests: { cpu: '250m', memory: '256Mi' },
    limits: { cpu: '500m', memory: '512Mi' }
  };

  // Add imagePullSecrets for ECR
  let imagePullSecretsSection = '';
  if (config.imageRegistry && config.imageRegistry.includes('amazonaws.com')) {
    imagePullSecretsSection = `      imagePullSecrets:
      - name: ecr-registry-secret
`;
  }

  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${config.appName}
  namespace: ${config.namespace || 'default'}
  labels:
    app: ${config.appName}
spec:
  replicas: ${config.replicas}
  selector:
    matchLabels:
      app: ${config.appName}
  template:
    metadata:
      labels:
        app: ${config.appName}
    spec:
${imagePullSecretsSection}      containers:
      - name: ${config.appName}
        image: ${imageName}
        ports:
        - containerPort: ${port}
          name: http
${envSection}
        resources:
          requests:
            memory: "${resources.requests.memory}"
            cpu: "${resources.requests.cpu}"
          limits:
            memory: "${resources.limits.memory}"
            cpu: "${resources.limits.cpu}"
        livenessProbe:
          httpGet:
            path: ${healthPath}
            port: ${port}
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: ${healthPath}
            port: ${port}
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 3
`;
}

export function generateServiceManifest(config: AWSConfig, appType: AppType): string {
  const port = appType === 'react' || appType === 'vue' ? 80 : config.port;

  return `apiVersion: v1
kind: Service
metadata:
  name: ${config.appName}-service
  namespace: ${config.namespace || 'default'}
  labels:
    app: ${config.appName}
spec:
  type: ClusterIP
  ports:
  - port: 80
    targetPort: ${port}
    protocol: TCP
    name: http
  selector:
    app: ${config.appName}
`;
}

export function generateIngressManifest(config: AWSConfig): string {
  const hostname = config.domain 
    ? (config.domain.subdomain ? `${config.domain.subdomain}.${config.domain.domain}` : config.domain.domain)
    : `${config.appName}.example.com`;

  // Start with HTTP only, HTTPS will be enabled after certificate validation
  let annotations = `    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80}]'`;

  // Certificate and HTTPS will be added after validation in waitForIngressAndSetupDNS
  // This prevents ALB from failing to create HTTPS listener with invalid certificate


  let tlsSection = '';
  if (config.domain && config.domain.enableSSL && config.domain.certificateARN) {
    tlsSection = `  tls:
  - hosts:
    - ${hostname}
    secretName: ${config.appName}-tls`;
  }

  return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${config.appName}-ingress
  namespace: ${config.namespace || 'default'}
  annotations:
${annotations}
spec:
  ingressClassName: alb
  rules:
  - host: ${hostname}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ${config.appName}-service
            port:
              number: 80
${tlsSection}
`;
}

export function generateAutoscalingManifest(config: AWSConfig): string {
  if (!config.autoscaling || !config.autoscaling.enabled) {
    return '';
  }

  const targetCPU = config.autoscaling.targetCPU || 70;

  return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${config.appName}-hpa
  namespace: ${config.namespace || 'default'}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${config.appName}
  minReplicas: ${config.autoscaling.minReplicas}
  maxReplicas: ${config.autoscaling.maxReplicas}
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: ${targetCPU}
`;
}

export function generateSecretsManifest(config: AWSConfig): string {
  if (!config.secrets || Object.keys(config.secrets).length === 0) {
    return '';
  }

  const secrets: string[] = [];
  for (const [key, value] of Object.entries(config.secrets)) {
    const encoded = Buffer.from(value).toString('base64');
    secrets.push(`  ${key}: ${encoded}`);
  }

  return `apiVersion: v1
kind: Secret
metadata:
  name: ${config.appName}-secrets
  namespace: ${config.namespace || 'default'}
type: Opaque
data:
${secrets.join('\n')}
`;
}

