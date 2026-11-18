// What the office does with its tables, gathered here from the office-*.ts modules.
// Code outside these modules imports from this file; the modules import each
// other directly.
import {
  asks,
  attachments,
  pokes,
  connectors,
  grants,
  jobs,
  ledger,
  reports,
  runs,
  staff,
  tasks
} from './schema.ts';

export type StaffRow = typeof staff.$inferSelect;
export type AskRow = typeof asks.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type PokeRow = typeof pokes.$inferSelect;
export type ReportRow = typeof reports.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type GrantRow = typeof grants.$inferSelect;
export type ConnectorRow = typeof connectors.$inferSelect;
export type LedgerRow = Omit<typeof ledger.$inferSelect, 'embedding' | 'embeddingModel'>;

/**
 * The keys of the runs going in this process. The office gives every run one,
 * and a thread it takes a hand-off on keeps it (`threads.runs`), so while it
 * goes the hub's pick-ups there wait (`waitsOnOwnRun`). Kept in memory, not
 * the database: a restart ends every run, and so every hold, and nothing
 * waits forever.
 */
export { runsGoing, reserveRun, releaseRun } from './run-registry.ts';

export { skillsOf, setSkill, type Skill, type SkillCopy } from './staff-skills.ts';

export {
  roster,
  staffer,
  anyStaffer,
  formerStaff,
  setPermission,
  setActsOnHandOffs,
  ActCheckNeeded,
  actCheckPassed,
  passActCheck,
  NETWORK_NOTE,
  networkHeld,
  holdNetwork,
  resetHeldNetwork,
  heldReach,
  officeAgent,
  setAgent,
  setTool,
  setEffort,
  setModel,
  setOwnTool,
  type Hire,
  lookTaken,
  lookCatalogue,
  drawnParts,
  setLook,
  hire
} from './office-staff.ts';
export {
  setFolder,
  folderAskRefused,
  switchAskRefused,
  switchesOff,
  STORE_MARKS,
  SECRET_STORES,
  FOLDER_REFUSED,
  FOLDER_WARNING,
  broadFolder,
  GLOB,
  within,
  shownFolder,
  touchesSecretStore,
  checkFolder
} from './office-folders.ts';
export { record, searchLedger, precedent, reindexLedger } from './office-ledger.ts';
export {
  AlreadyOnDesk,
  raiseAsk,
  ask,
  asksFor,
  DECISIONS,
  type Decision,
  answeredWith,
  standsFor
} from './office-asks.ts';
export {
  decideAsk,
  type Approval,
  approveAsk,
  approveReply,
  approveFilter,
  approveCall,
  type CallPlace,
  raiseCall,
  callResultText,
  type FolderNotGiven,
  giveFolder,
  withdrawAsk,
  withdrawTask,
  replyToReport
} from './office-decide.ts';
export {
  type FollowUpRow,
  startFirstDay,
  followUpsToDo,
  followUpsToStart,
  type Unparked,
  startFollowUp,
  OUTCOME_TITLE,
  finishFollowUp,
  CUT_OFF_RESULT,
  closeStaleFollowUps,
  CUT_OFF_WORK,
  workTitle
} from './office-follow-ups.ts';
export {
  grantAccess,
  reconnectTask,
  changeAwsTask,
  SERVICE_NAME_MAX,
  renameConnector,
  serviceNames,
  type OfficeService,
  services,
  AWS_SECRETS_ID,
  AWS_READ_ID,
  AWS_BUILD_ID,
  AWS_IDS,
  isAws,
  AWS_SIGN_IN,
  connector,
  catalog,
  addConnector,
  GOOGLE,
  googleConnectors,
  addGoogleAccount,
  mailboxOf,
  nameConnector,
  googleAccountHeld,
  signedInAs,
  sayOnSignIn,
  setConnectorConfig,
  reconfigureConnector,
  bindPostalMailbox,
  connectorReady,
  grantsFor,
  setGrantLevel,
  revoke
} from './office-access.ts';
export {
  notesOf,
  type ListedTool,
  type ToolChanges,
  changesSaid,
  toolsChanged,
  refreshTools
} from './office-service-tools.ts';
export {
  giveTask,
  taskFiles,
  mediaTypeOf,
  task,
  tickStep,
  untickStep,
  tickKey,
  TaskResponseConflict,
  saveTaskResponse,
  finishTask,
  tasksFrom
} from './office-tasks.ts';
export {
  addReport,
  readReport,
  type Desk,
  desk,
  type OnDesk,
  stillOnDesk,
  type Delivery,
  deliveries,
  report
} from './office-desk.ts';
export {
  jobsFor,
  addJob,
  type FileJob,
  fileJobs,
  fileCycle,
  refuseFileCycle,
  updateJob,
  type GoAhead,
  editOwnJob,
  setDescription,
  DescriptionChanged,
  deleteJob,
  enabledJobs,
  job,
  setNextRun,
  claimScheduledRun,
  type ScheduledInput,
  scheduledInput,
  fileRuns,
  writerOf,
  inputFor,
  latestScheduledRuns,
  startRun,
  finishRun,
  closeStaleRuns,
  officeActivity
} from './office-jobs.ts';
export {
  type ModelUsage,
  recordUsage,
  type PlanWindows,
  setPlanLimits,
  WINDOW_ASK_LAPSED,
  windowAsksDue,
  ownerName,
  welcomed,
  finishWelcome,
  setOwnerName,
  plan,
  type UsageTotals,
  type UsageBucket,
  usageFor
} from './office-usage.ts';
export {
  schedulePoke,
  waitingPokes,
  unreadPokes,
  readPokes,
  cancelPoke,
  pokeNow,
  claimPoke,
  switchedOffIn,
  setSwitch,
  roomNamesFor,
  renameRoom
} from './office-pokes.ts';
