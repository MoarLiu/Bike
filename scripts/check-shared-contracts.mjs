import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

// Infer the implementation in a separate directory without its declaration
// sibling, then compare public return fields with the hand-written contract.
const root = path.resolve(new URL('..', import.meta.url).pathname);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bike-contracts-'));
try {
  await fs.mkdir(path.join(directory, 'src'));
  await fs.mkdir(path.join(directory, 'shared'));
  await fs.copyFile(path.join(root, 'src/types.ts'), path.join(directory, 'src/types.ts'));
  const modules = (await fs.readdir(path.join(root, 'shared'))).filter((file) => file.endsWith('.mjs'));
  for (const file of modules) await fs.copyFile(path.join(root, 'shared', file), path.join(directory, 'shared', file));
  const checks = [];
  const api = {
    'bike-knowledge': ['insertLinkAtQuery', 'buildKnowledgeIndex', 'searchKnowledge', 'suggestLinkTargets', 'renameTarget', 'copiedKnowledgeFragment', 'moveSubtreeConnections', 'remapCollidingIds', 'attachReference', 'finalizeMarkdownExport', 'expandAncestors', 'createBackupSchedule', 'reduceBackupSchedule'],
    'bike-markdown': ['markdownSourceMap', 'markdownTableCells', 'parseMarkdownToNodes', 'markdownLinkOrigins'],
    'bike-limits': ['assertTreeBudget', 'assertValueBudget'],
    'bike-attachments': ['workspaceAttachmentAssets', 'workspaceFormatVersion', 'collectAttachmentRefs', 'validateAttachmentMetadata'],
  };
  for (const [module, names] of Object.entries(api)) {
    const raw = await fs.readFile(path.join(root, 'shared', module + '.d.mts'), 'utf8');
    await fs.writeFile(path.join(directory, 'shared', module + '.contract.d.mts'), raw);
    const alias = module.replaceAll('-', '_');
    checks.push(`import * as actual_${alias} from './shared/${module}.mjs';`, `import * as declared_${alias} from './shared/${module}.contract.mjs';`);
    for (const name of names) checks.push(`const ${alias}_${name}: never = null as unknown as Exclude<Keys<Awaited<ReturnType<typeof actual_${alias}.${name}>>>, Keys<Awaited<ReturnType<typeof declared_${alias}.${name}>>>>;`);
  }
  const file = path.join(directory, 'contracts.mts');
  await fs.writeFile(file, `type Keys<T> = T extends unknown ? keyof T : never;\n${checks.join('\n')}\n`);
  const program = ts.createProgram([file], { allowJs: true, checkJs: false, noEmit: true, strict: false, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
  const errors = ts.getPreEmitDiagnostics(program);
  if (errors.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => directory, getCanonicalFileName: (file) => file, getNewLine: () => '\n' }));
    process.exitCode = 1;
  } else console.log(`Shared return contracts passed: ${Object.values(api).flat().length} APIs (inferred implementation versus declarations).`);
} finally { await fs.rm(directory, { recursive: true, force: true }); }
