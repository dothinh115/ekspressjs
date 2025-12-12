export type AppType = 'next' | 'nuxt' | 'nest' | 'react' | 'vue';

export interface ResourceLimits {
  cpu: string;
  memory: string;
}

export interface ResourceRequests {
  cpu: string;
  memory: string;
}

export interface Resources {
  requests: ResourceRequests;
  limits: ResourceLimits;
}

export interface Autoscaling {
  enabled: boolean;
  minReplicas: number;
  maxReplicas: number;
  targetCPU?: number;
  targetMemory?: number;
}

export interface DomainConfig {
  domain: string;
  subdomain?: string;
  enableSSL: boolean;
  certificateARN?: string;
  cloudflareApiToken: string;
  cloudflareZoneId: string;
}

export interface EnvVar {
  name: string;
  value: string;
  fromSecret?: boolean;
  secretKey?: string;
}

export interface DeployConfig {
  appType: AppType;
  appName: string;
  port: number;
  replicas: number;
  region: string;
  clusterName: string;
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
  // Optional directory to store generated deployment artifacts (Dockerfile, k8s/)
  artifactDir?: string;
}

