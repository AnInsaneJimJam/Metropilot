import { randomBytes } from "node:crypto";
import {
  compileWorkspace,
  compileStrategy,
  profileIssues,
  LanguageError,
  locateBlock,
} from "@monad-hack/strategy";
import { paperBudgetIssue } from "@monad-hack/contracts";
import type { GeneratedContractMap } from "@monad-hack/contracts";
import type { Catalog } from "@monad-hack/strategy";
export type SaveStrategy = GeneratedContractMap["controlSave"];
export type SavedAgent = GeneratedContractMap["controlAgent"];
export class ControlError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: object;
  constructor(
    status: number,
    code: string,
    message: string,
    details: object = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
/** UUIDv7: 48-bit timestamp, version nibble, RFC variant, cryptographically random remainder. */
export function newId(): string {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b[6] = 0x70 | (b[6]! & 0x0f);
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function checkBudget(request: SaveStrategy): void {
  const issue = paperBudgetIssue(request.budget, false);
  if (issue)
    throw new ControlError(422, "LIMIT_EXCEEDED", issue, {
      fieldPath: "/budget",
    });
}
/** Server compilation of a draft against the enabled paper catalog (resolved from catalog_versions, issue #18). */
export async function validateDraft(request: SaveStrategy, catalog: Catalog) {
  if (!request.name.trim())
    throw new ControlError(
      400,
      "SCHEMA_INVALID",
      "Give this strategy a name.",
      { fieldPath: "/name" },
    );
  checkBudget(request);
  const converted = compileWorkspace(request.workspace, catalog);
  const issues = profileIssues(converted.strategy, {
    experience: request.experience,
    mode: "paper",
  });
  if (issues.length) {
    const issue = issues[0]!;
    throw new ControlError(422, issue.code, issue.message, {
      nodeId: locateBlock(issue, converted.sourceMap),
      fieldPath: issue.fieldPath,
    });
  }
  let program;
  try {
    program = await compileStrategy(
      JSON.stringify(converted.strategy),
      catalog,
    );
  } catch (error) {
    if (error instanceof LanguageError)
      throw new ControlError(422, error.code, error.message, {
        nodeId: locateBlock(error, converted.sourceMap),
        fieldPath: error.fieldPath,
      });
    throw error;
  }
  const issue = paperBudgetIssue(request.budget, program.bounds.aiCalls > 0);
  if (issue)
    throw new ControlError(422, "LIMIT_EXCEEDED", issue, {
      fieldPath: "/budget",
    });
  return program;
}
