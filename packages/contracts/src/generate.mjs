// Generated types are build artifacts. The JSON Schemas are the only wire-shape source.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';
const schema = JSON.parse(await readFile(new URL('./strategy.schema.json', import.meta.url), 'utf8'));
await writeFile(new URL('./generated.ts', import.meta.url), await compile(schema, 'Strategy', { additionalProperties: false, unreachableDefinitions: true, ignoreMinAndMaxItems: true }));

// Non-strategy contracts in ../schemas. One root keyed by kind gives every named definition one declaration.
// Keep these refs in step with contractRefs in index.ts; strategy is typed from generated.ts above.
const refs = {
  connectorManifest: 'connector-manifest-1.schema.json',
  priceObservation: 'price-observation-1.schema.json',
  controlSave: 'control-workspace-1.schema.json#/$defs/SaveStrategy',
  controlAgent: 'control-workspace-1.schema.json#/$defs/SavedAgent',
  deploymentRequest: 'deployment-request-1.schema.json',
  error: 'error-1.schema.json',
  event: 'event-1.schema.json',
  auditEvent: 'audit-event-1.schema.json',
  assetIdentity: 'common.schema.json#/$defs/assetIdentity',
  actionIntent: 'action-intent-1.schema.json',
  intentResult: 'intent-result-1.schema.json',
  runtimeAssignment: 'runtime-assignment-1.schema.json',
  assignmentPoll: 'assignment-poll-1.schema.json',
  assignmentOffer: 'assignment-offer-1.schema.json',
  runWait: 'run-wait-1.schema.json',
  runResult: 'run-result-1.schema.json',
  runComplete: 'run-complete-1.schema.json',
  runState: 'run-state-1.schema.json',
  timelineEntry: 'timeline-entry-1.schema.json',
  brokerRequest: 'broker-request-1.schema.json',
  brokerResult: 'broker-result-1.schema.json',
  assignmentOffer2: 'assignment-offer-2.schema.json',
  artifact: 'artifact-1.schema.json',
  runtimeHeartbeat: 'runtime-heartbeat-1.schema.json',
  runtimeLease: 'runtime-lease-1.schema.json',
  audienceCapability: 'audience-capability-1.schema.json',
  deploymentManifest: 'deployment-manifest-1.schema.json',
  auditEvent2: 'audit-event-2.schema.json',
  paperEstimate: 'control-lifecycle-1.schema.json#/$defs/PaperEstimate',
  deploymentOperation: 'control-lifecycle-1.schema.json#/$defs/DeploymentOperation',
  agentDeployment: 'control-lifecycle-1.schema.json#/$defs/AgentDeployment',
  runSummary: 'control-lifecycle-1.schema.json#/$defs/RunSummary',
  runDetail: 'control-lifecycle-1.schema.json#/$defs/RunDetail',
  allocationRequest: 'funds-1.schema.json#/$defs/AllocationRequest',
  stepUpRequest: 'funds-1.schema.json#/$defs/StepUpRequest',
  stepUpVerification: 'funds-1.schema.json#/$defs/StepUpVerification',
  destinationRequest: 'funds-1.schema.json#/$defs/DestinationRequest',
  withdrawalRequest: 'funds-1.schema.json#/$defs/WithdrawalRequest',
  fundingQuoteRequest: 'funds-1.schema.json#/$defs/FundingQuoteRequest',
  agentFunds: 'funds-1.schema.json#/$defs/AgentFunds',
  withdrawal: 'funds-1.schema.json#/$defs/Withdrawal',
  fundingQuote: 'funds-1.schema.json#/$defs/FundingQuote',
};
const root = {
  title: 'GeneratedContractMap',
  type: 'object',
  additionalProperties: false,
  required: Object.keys(refs),
  properties: Object.fromEntries(Object.entries(refs).map(([kind, ref]) => [kind, { $ref: ref }])),
};
await writeFile(new URL('./generated-contracts.ts', import.meta.url), await compile(root, 'GeneratedContractMap', {
  cwd: fileURLToPath(new URL('../schemas/', import.meta.url)),
  strictIndexSignatures: true,
  maxItems: -1,
  // Runtime contracts reuse strategy definitions (Amount, RunCheckpoint, Binding) by the strategy schema's $id.
  $refOptions: {
    resolve: {
      http: false,
      strategy: { order: 1, canRead: /^https:\/\/monad-hack\.local\/strategy\/1/, read: () => JSON.stringify(schema) },
    },
  },
}));
