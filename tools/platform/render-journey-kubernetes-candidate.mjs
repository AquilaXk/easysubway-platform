import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isIPv4 } from "node:net";

const INPUT_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "releaseTuple",
  "tupleSha256",
  "candidateGeneration",
  "trafficGeneration",
  "nodeInternalIp",
  "postgresPort",
  "objectStoragePort",
  "secretIdentity",
]);
const TUPLE_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "backendImageDigest",
  "backendConfigDigest",
  "journeyContractDigest",
  "serverRouteBundleDigest",
  "deploymentRevision",
  "environmentIdentity",
]);
const TUPLE_IDENTITY_FIELDS = Object.freeze(TUPLE_FIELDS.slice(2));
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const ENVIRONMENT = /^[A-Za-z0-9._-]{1,255}$/;
const NAMESPACE = "easysubway-journey";

class K3sRenderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new K3sRenderError(code, message);
}

function exactKeys(value, fields) {
  return value !== null
    && !Array.isArray(value)
    && typeof value === "object"
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--input" || !args[1] || args[1].startsWith("--")) {
    fail("E_K3S_RENDER_INPUT", "expected exactly --input <regular-file>");
  }
  return args[1];
}

function readInput(path) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    fail("E_K3S_RENDER_INPUT", "input must be a regular file");
  }
  try {
    if (!fstatSync(descriptor).isFile()) fail("E_K3S_RENDER_INPUT", "input must be a regular file");
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error instanceof K3sRenderError) throw error;
    fail("E_K3S_RENDER_INPUT", "input must contain valid JSON");
  } finally {
    closeSync(descriptor);
  }
}

function tupleSha256(tuple) {
  const bytes = `${TUPLE_IDENTITY_FIELDS.map((field) => tuple[field]).join("\n")}\n`;
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function validateTuple(tuple) {
  if (!exactKeys(tuple, TUPLE_FIELDS)) fail("E_K3S_RENDER_INPUT", "releaseTuple must be closed");
  if (tuple.schemaVersion !== "JOURNEY_RELEASE_TUPLE_V1" || tuple.artifactKind !== "journey-release-tuple") {
    fail("E_K3S_RENDER_IDENTITY", "releaseTuple constants are invalid");
  }
  for (const field of TUPLE_IDENTITY_FIELDS.slice(0, 4)) {
    if (typeof tuple[field] !== "string" || !DIGEST.test(tuple[field])) {
      fail("E_K3S_RENDER_IDENTITY", `${field} must be an immutable digest`);
    }
  }
  if (typeof tuple.deploymentRevision !== "string" || !REVISION.test(tuple.deploymentRevision)) {
    fail("E_K3S_RENDER_IDENTITY", "deploymentRevision must be a Git SHA");
  }
  if (typeof tuple.environmentIdentity !== "string" || !ENVIRONMENT.test(tuple.environmentIdentity)) {
    fail("E_K3S_RENDER_IDENTITY", "environmentIdentity is invalid");
  }
}

function privateIpv4(value) {
  if (typeof value !== "string" || !isIPv4(value)) return false;
  const octets = value.split(".").map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function validateInput(input) {
  if (!exactKeys(input, INPUT_FIELDS)) fail("E_K3S_RENDER_INPUT", "input must contain the exact candidate fields");
  if (input.schemaVersion !== "PLATFORM_K3S_CANDIDATE_INPUT_V1" || input.artifactKind !== "platform-k3s-candidate-input") {
    fail("E_K3S_RENDER_INPUT", "input constants are invalid");
  }
  validateTuple(input.releaseTuple);
  if (typeof input.tupleSha256 !== "string" || input.tupleSha256 !== tupleSha256(input.releaseTuple)) {
    fail("E_K3S_RENDER_IDENTITY", "tupleSha256 does not bind releaseTuple");
  }
  if (!Number.isSafeInteger(input.candidateGeneration) || input.candidateGeneration < 1) {
    fail("E_K3S_RENDER_IDENTITY", "candidateGeneration must be positive");
  }
  if (!Number.isSafeInteger(input.trafficGeneration) || input.trafficGeneration < 1) {
    fail("E_K3S_RENDER_IDENTITY", "trafficGeneration must be positive");
  }
  if (!privateIpv4(input.nodeInternalIp)) fail("E_K3S_RENDER_NETWORK", "nodeInternalIp must be a private IPv4 address");
  if (input.postgresPort !== 15432 || input.objectStoragePort !== 9000) {
    fail("E_K3S_RENDER_NETWORK", "external service ports must match the fixed-host contract");
  }
  if (typeof input.secretIdentity !== "string" || !DIGEST.test(input.secretIdentity)) {
    fail("E_K3S_RENDER_IDENTITY", "secretIdentity must be an immutable digest");
  }
}

function digestHex(value) {
  return value.slice("sha256:".length);
}

function candidateToken(input) {
  return createHash("sha256")
    .update(`${input.tupleSha256}\n${input.candidateGeneration}\n`, "utf8")
    .digest("hex")
    .slice(0, 20);
}

function labels(token) {
  return {
    "app.kubernetes.io/name": "easysubway-journey",
    "app.kubernetes.io/component": "backend",
    "app.kubernetes.io/part-of": "easysubway",
    "easysubway.io/role": "candidate",
    "easysubway.io/candidate-token": token,
  };
}

function annotations(input) {
  return {
    "easysubway.io/tuple-sha256": input.tupleSha256,
    "easysubway.io/backend-image-digest": input.releaseTuple.backendImageDigest,
    "easysubway.io/backend-config-digest": input.releaseTuple.backendConfigDigest,
    "easysubway.io/journey-contract-digest": input.releaseTuple.journeyContractDigest,
    "easysubway.io/server-route-bundle-digest": input.releaseTuple.serverRouteBundleDigest,
    "easysubway.io/deployment-revision": input.releaseTuple.deploymentRevision,
    "easysubway.io/environment-identity": input.releaseTuple.environmentIdentity,
    "easysubway.io/candidate-generation": String(input.candidateGeneration),
    "easysubway.io/traffic-generation": String(input.trafficGeneration),
  };
}

function externalService(name, servicePort, targetPort) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: NAMESPACE, labels: { "app.kubernetes.io/part-of": "easysubway" } },
    spec: { ports: [{ name, port: servicePort, protocol: "TCP", targetPort }] },
  };
}

function externalEndpointSlice(name, address, port) {
  return {
    apiVersion: "discovery.k8s.io/v1",
    kind: "EndpointSlice",
    metadata: {
      name: `${name}-v1`,
      namespace: NAMESPACE,
      labels: { "kubernetes.io/service-name": name, "app.kubernetes.io/part-of": "easysubway" },
    },
    addressType: "IPv4",
    endpoints: [{ addresses: [address] }],
    ports: [{ name, protocol: "TCP", port }],
  };
}

function probe(path, initialDelaySeconds, failureThreshold) {
  return {
    httpGet: { path, port: 8080, scheme: "HTTP" },
    initialDelaySeconds,
    periodSeconds: 5,
    timeoutSeconds: 2,
    failureThreshold,
    successThreshold: 1,
  };
}

function deployment(input, token, deploymentName, configName, secretName) {
  const objectLabels = labels(token);
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: deploymentName, namespace: NAMESPACE, labels: objectLabels, annotations: annotations(input) },
    spec: {
      replicas: 1,
      revisionHistoryLimit: 1,
      progressDeadlineSeconds: 360,
      strategy: { type: "Recreate" },
      selector: { matchLabels: objectLabels },
      template: {
        metadata: { labels: objectLabels, annotations: annotations(input) },
        spec: {
          serviceAccountName: "journey-backend",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 30,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            fsGroup: 10001,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [{
            name: "backend",
            image: `ghcr.io/aquilaxk/easysubway-backend@${input.releaseTuple.backendImageDigest}`,
            imagePullPolicy: "IfNotPresent",
            ports: [{ name: "http", containerPort: 8080, protocol: "TCP" }],
            envFrom: [{ configMapRef: { name: configName } }, { secretRef: { name: secretName } }],
            resources: {
              requests: { cpu: "250m", memory: "1Gi", "ephemeral-storage": "256Mi" },
              limits: { cpu: "1500m", memory: "4Gi", "ephemeral-storage": "1Gi" },
            },
            securityContext: {
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            startupProbe: probe("/actuator/health/readiness", 2, 60),
            readinessProbe: probe("/actuator/health/readiness", 0, 3),
            livenessProbe: probe("/actuator/health/liveness", 10, 3),
            volumeMounts: [
              { name: "tmp", mountPath: "/tmp" },
              { name: "logs", mountPath: "/app/logs" },
            ],
          }],
          volumes: [
            { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "128Mi" } },
            { name: "logs", emptyDir: { sizeLimit: "256Mi" } },
          ],
        },
      },
    },
  };
}

function candidateService(token, name) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, namespace: NAMESPACE, labels: labels(token) },
    spec: {
      type: "ClusterIP",
      selector: labels(token),
      ports: [{ name: "http", port: 8080, protocol: "TCP", targetPort: 8080 }],
    },
  };
}

function networkPolicy(input) {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "journey-backend-boundary", namespace: NAMESPACE },
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": "easysubway-journey" } },
      policyTypes: ["Ingress", "Egress"],
      ingress: [{
        from: [
          { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": NAMESPACE } } },
          { ipBlock: { cidr: `${input.nodeInternalIp}/32` } },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      }],
      egress: [
        { to: [{ ipBlock: { cidr: `${input.nodeInternalIp}/32` } }], ports: [{ protocol: "TCP", port: 15432 }, { protocol: "TCP", port: 9000 }] },
        { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
      ],
    },
  };
}

function activeServiceTemplate(token) {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "journey-active", namespace: NAMESPACE, labels: { "app.kubernetes.io/part-of": "easysubway" } },
    spec: {
      type: "NodePort",
      externalTrafficPolicy: "Local",
      selector: labels(token),
      ports: [{ name: "http", port: 8080, protocol: "TCP", targetPort: 8080, nodePort: 32080 }],
    },
  };
}

function render(input) {
  validateInput(input);
  const token = candidateToken(input);
  const deploymentName = `journey-candidate-${token}`;
  const serviceName = `journey-candidate-${token}`;
  const configName = `journey-config-${digestHex(input.releaseTuple.backendConfigDigest).slice(0, 16)}`;
  const secretName = `journey-secret-${digestHex(input.secretIdentity).slice(0, 16)}`;
  const releaseIdentity = {
    tupleSha256: input.tupleSha256,
    backendImageDigest: input.releaseTuple.backendImageDigest,
    backendConfigDigest: input.releaseTuple.backendConfigDigest,
    journeyContractDigest: input.releaseTuple.journeyContractDigest,
    serverRouteBundleDigest: input.releaseTuple.serverRouteBundleDigest,
    deploymentRevision: input.releaseTuple.deploymentRevision,
    environmentIdentity: input.releaseTuple.environmentIdentity,
    candidateGeneration: input.candidateGeneration,
    trafficGeneration: input.trafficGeneration,
    candidateToken: token,
  };
  const configPlan = {
    name: configName,
    namespace: NAMESPACE,
    digest: input.releaseTuple.backendConfigDigest,
    immutable: true,
    requiredProjection: "EXACT_VALIDATED_NON_SECRET_BACKEND_ENV",
    internalEndpoints: {
      postgres: {
        protocol: "TCP",
        host: "journey-postgres.easysubway-journey.svc",
        port: 5432,
      },
      objectStorage: {
        scheme: "HTTP",
        host: "journey-object-storage.easysubway-journey.svc",
        port: 9000,
      },
    },
    overrides: {
      SPRING_PROFILES_ACTIVE: "prod",
      EASYSUBWAY_PUSH_DELIVERY_ENABLED: "false",
      EASYSUBWAY_JOURNEY_V3_READINESS_RELEASE_TUPLE_SHA256: digestHex(input.tupleSha256),
      EASYSUBWAY_JOURNEY_V3_READINESS_BACKEND_IMAGE_DIGEST: input.releaseTuple.backendImageDigest,
      EASYSUBWAY_JOURNEY_V3_READINESS_BACKEND_CONFIG_SHA256: digestHex(input.releaseTuple.backendConfigDigest),
      EASYSUBWAY_JOURNEY_V3_READINESS_JOURNEY_CONTRACT_SHA256: digestHex(input.releaseTuple.journeyContractDigest),
      EASYSUBWAY_JOURNEY_V3_READINESS_DEPLOYMENT_REVISION: input.releaseTuple.deploymentRevision,
      EASYSUBWAY_JOURNEY_V3_READINESS_TRAFFIC_GENERATION: String(input.trafficGeneration),
      EASYSUBWAY_JOURNEY_V3_READINESS_INSTANCE_ID: deploymentName,
    },
  };
  const secretPlan = {
    name: secretName,
    namespace: NAMESPACE,
    identity: input.secretIdentity,
    immutable: true,
    requiredKeyProjection: "EXACT_VALIDATED_BACKEND_ENV_ALLOWLIST",
    serializedValueCount: 0,
  };
  return {
    schemaVersion: "PLATFORM_K3S_CANDIDATE_RENDER_V1",
    artifactKind: "platform-k3s-candidate-render",
    releaseIdentity,
    configPlan,
    secretPlan,
    candidateObjects: [
      {
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: NAMESPACE, labels: { "kubernetes.io/metadata.name": NAMESPACE, "app.kubernetes.io/part-of": "easysubway" } },
      },
      {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: { name: "journey-backend", namespace: NAMESPACE },
        automountServiceAccountToken: false,
      },
      externalService("journey-postgres", 5432, input.postgresPort),
      externalEndpointSlice("journey-postgres", input.nodeInternalIp, input.postgresPort),
      externalService("journey-object-storage", 9000, input.objectStoragePort),
      externalEndpointSlice("journey-object-storage", input.nodeInternalIp, input.objectStoragePort),
      deployment(input, token, deploymentName, configName, secretName),
      candidateService(token, serviceName),
      networkPolicy(input),
    ],
    activationPlan: {
      candidateDeploymentName: deploymentName,
      candidateServiceName: serviceName,
      candidateProbeBoundary: "TASK_OWNED_LOOPBACK_KUBECTL_PORT_FORWARD",
      activeServiceName: "journey-active",
      activeServiceTemplate: activeServiceTemplate(token),
      selectorPatch: labels(token),
      requiredCasField: "metadata.resourceVersion",
      trafficGeneration: input.trafficGeneration,
      nodePortAddresses: ["127.0.0.0/8"],
      applyDuringCandidatePreparation: false,
    },
  };
}

try {
  const inputPath = parseArguments(process.argv.slice(2));
  const output = render(readInput(inputPath));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  if (error instanceof K3sRenderError) {
    process.stderr.write(`${error.code} ${error.message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write("E_K3S_RENDER_INPUT unexpected render failure\n");
    process.exitCode = 2;
  }
}
