import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const SKIPPED_DIRECTORIES = new Set([".git", ".ade", "node_modules", "dist", "build", ".next"]);
const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".html", ".java", ".js", ".json",
  ".jsx", ".kt", ".md", ".mjs", ".php", ".py", ".rb", ".rs", ".sh", ".sql", ".swift",
  ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml"
]);
const PRIORITY_FILES = new Set([
  "AGENTS.md", "CLAUDE.md", "CONTEXT.md", "README.md", "package.json", "pyproject.toml",
  "Cargo.toml", "go.mod"
]);

async function collectFiles(rootPath, currentPath, files, limit) {
  if (files.length >= limit) return;
  const entries = await readdir(currentPath, { withFileTypes: true });
  entries.sort((left, right) => {
    const leftDirectory = left.isDirectory() ? 1 : 0;
    const rightDirectory = right.isDirectory() ? 1 : 0;
    return leftDirectory - rightDirectory || left.name.localeCompare(right.name);
  });
  for (const entry of entries) {
    if (files.length >= limit) break;
    if (entry.isSymbolicLink()) continue;
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await collectFiles(rootPath, absolutePath, files, limit);
      }
      continue;
    }
    if (entry.isFile()) files.push(path.relative(rootPath, absolutePath).replaceAll("\\", "/"));
  }
}

async function readSnippet(rootPath, relativePath, maxCharacters) {
  const extension = path.extname(relativePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension) && !PRIORITY_FILES.has(path.basename(relativePath))) return null;
  try {
    const contents = await readFile(path.join(rootPath, relativePath), "utf8");
    return contents.slice(0, maxCharacters);
  } catch {
    return null;
  }
}

export async function buildProjectContext(projectPath, options = {}) {
  const maximumFiles = options.maximumFiles ?? 80;
  const maximumSnippets = options.maximumSnippets ?? 8;
  const maximumSnippetCharacters = options.maximumSnippetCharacters ?? 4_000;
  const projectStat = await stat(projectPath);
  if (!projectStat.isDirectory()) throw new Error(`Project path is not a directory: ${projectPath}`);

  const files = [];
  await collectFiles(projectPath, projectPath, files, maximumFiles);
  const prioritized = [...files].sort((left, right) => {
    const leftPriority = PRIORITY_FILES.has(path.basename(left)) ? 0 : 1;
    const rightPriority = PRIORITY_FILES.has(path.basename(right)) ? 0 : 1;
    return leftPriority - rightPriority || left.localeCompare(right);
  });
  const snippets = [];
  for (const relativePath of prioritized) {
    if (snippets.length >= maximumSnippets) break;
    const contents = await readSnippet(projectPath, relativePath, maximumSnippetCharacters);
    if (contents) snippets.push({ path: relativePath, contents });
  }

  return {
    root: projectPath,
    files,
    truncated: files.length === maximumFiles,
    snippets
  };
}
