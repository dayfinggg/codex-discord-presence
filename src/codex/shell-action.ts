interface Rule {
  name: string;
  pattern: RegExp;
}

const HIGH_LEVEL_RULES: Rule[] = [
  { name: "restart_service", pattern: /(?:stop-process|taskkill|\bkill\b)[\s\S]*(?:start-process|start-service|\bstart\b)/i },
  { name: "run_tests", pattern: /(?:\bbun\s+test\b|\bnpm\s+(?:run\s+)?test\b|\bpnpm\s+(?:run\s+)?test\b|\byarn\s+(?:run\s+)?test\b|\bpytest\b|\bpython\s+-m\s+(?:pytest|unittest)\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bgo\s+test\b|\bmvn\w*\s+test\b|\bgradlew?\b[^\r\n;]*\btest\b)/i },
  { name: "check_types", pattern: /(?:\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?typecheck\b|\btsc\b[^\r\n;]*--noemit\b|\bpyright\b|\bmypy\b)/i },
  { name: "build_project", pattern: /(?:\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?build\b|\bcargo\s+build\b|\bdotnet\s+build\b|\bgo\s+build\b|\bmvn\w*\s+package\b|\bgradlew?\b[^\r\n;]*\bbuild\b)/i },
  { name: "run_lint", pattern: /(?:\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?lint\b|\beslint\b|\bbiome\s+(?:lint|check)\b|\bpylint\b|\bruff\s+check\b)/i },
  { name: "format_code", pattern: /(?:\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?format\b|\bprettier\b|\bbiome\s+format\b|\bblack\b|\bruff\s+format\b|\bgofmt\b|\bcargo\s+fmt\b)/i },
  { name: "install_dependencies", pattern: /(?:\b(?:bun|npm|pnpm|yarn)\s+(?:install|add|i)\b|\bpip(?:3)?\s+install\b|\bpoetry\s+(?:install|add)\b|\bcargo\s+add\b|\bdotnet\s+add\s+package\b)/i },
  { name: "deploy", pattern: /(?:\bdeploy\b|\bkubectl\s+apply\b|\bterraform\s+apply\b|\bvercel\b[^\r\n;]*\bdeploy\b)/i },
  { name: "manage_containers", pattern: /(?:\bdocker\b|\bdocker-compose\b|\bkubectl\b|\bpodman\b)/i },
  { name: "query_database", pattern: /(?:\bsqlite3?\b|\bpsql\b|\bmysql\b|\bsqlcmd\b|\bredis-cli\b|\bbun:sqlite\b)/i },
];

const FILE_RULES: Rule[] = [
  { name: "search_content", pattern: /(?:\bselect-string\b|(?:^|[\s;|&])rg(?:\.exe)?(?:\s|$)|(?:^|[\s;|&])grep(?:\.exe)?(?:\s|$)|\bfindstr(?:\.exe)?\b)/i },
  { name: "search_files", pattern: /(?:\bget-childitem\b|(?:^|[\s;|&])gci(?:\s|$)|(?:^|[\s;|&])ls(?:\s|$)|(?:^|[\s;|&])dir(?:\s|$)|(?:^|[\s;|&])find(?:\.exe)?(?:\s|$)|\bresolve-path\b)/i },
  { name: "read_files", pattern: /(?:\bget-content\b|(?:^|[\s;|&])cat(?:\s|$)|(?:^|[\s;|&])head(?:\s|$)|(?:^|[\s;|&])tail(?:\s|$)|(?:^|[\s;|&])less(?:\s|$)|\bsed\s+-n\b|\breadfilesync\b|\bread-file\b)/i },
  { name: "delete_files", pattern: /(?:\bremove-item\b|(?:^|[\s;|&])rm(?:\s|$)|(?:^|[\s;|&])del(?:\s|$)|\bunlink\b)/i },
  { name: "copy_files", pattern: /(?:\bcopy-item\b|(?:^|[\s;|&])cp(?:\s|$)|\bcopy-file\b)/i },
  { name: "move_files", pattern: /(?:\bmove-item\b|(?:^|[\s;|&])mv(?:\s|$)|\brename-item\b)/i },
  { name: "write_files", pattern: /(?:\bset-content\b|\badd-content\b|\bout-file\b|\bnew-item\b|\bwritefilesync\b|\bwrite-file\b|(?:^|[\s;|&])touch(?:\s|$)|(?:^|[\s;|&])tee(?:\s|$)|(?:^|[^>])>{1,2}(?!=))/i },
  { name: "archive_files", pattern: /(?:\bcompress-archive\b|\bexpand-archive\b|(?:^|[\s;|&])tar(?:\s|$)|(?:^|[\s;|&])zip(?:\s|$)|(?:^|[\s;|&])unzip(?:\s|$))/i },
];

function firstFileAction(command: string): string | undefined {
  let first: { name: string; index: number } | undefined;
  for (const rule of FILE_RULES) {
    const match = rule.pattern.exec(command);
    if (match && (!first || match.index < first.index)) first = { name: rule.name, index: match.index };
  }
  return first?.name;
}

export function classifyShellCommand(command: string | undefined): string {
  if (!command || command.trim() === "") return "shell_command";
  for (const rule of HIGH_LEVEL_RULES) {
    if (rule.pattern.test(command)) return rule.name;
  }
  if (/\bgit(?:\.exe)?\s+(?:status|diff|log|show|blame|rev-parse|branch|remote)\b/i.test(command)) return "inspect_git";
  if (/\bgit(?:\.exe)?\s+/i.test(command)) return "manage_git";
  if (/\bgh(?:\.exe)?\s+(?:auth\s+status|repo\s+view|api\b|issue\s+(?:list|view)|pr\s+(?:list|view|status))\b/i.test(command)) return "inspect_github";
  if (/\bgh(?:\.exe)?\s+/i.test(command)) return "manage_github";
  if (/(?:^|[\s;&|])(?:scp|rsync)(?:\.exe)?(?:\s|$)/i.test(command)) return "transfer_files";
  if (/(?:^|[\s;&|])ssh(?:\.exe)?(?:\s|$)/i.test(command)) return "remote_connection";
  if (/\b(?:npm|pnpm|yarn)\s+(?:view|info|search|outdated)\b/i.test(command)) return "inspect_packages";
  if (/(?:^|[\s;&|'"\\])codex(?:\.exe)?(?:['"]|\s)/i.test(command)) return "inspect_codex";
  if (/(?:\bbash\s+-n\b|\bnode\s+--check\b|\bpython(?:3)?\s+-m\s+py_compile\b)/i.test(command)) return "check_syntax";
  if (/(?:^|[\s;&|])(?:python|python3|node|bun|ruby|php|perl)(?:\.exe)?(?:\s|$)|\b(?:pwsh|powershell)(?:\.exe)?\s+-file\b/i.test(command)) {
    return "run_script";
  }
  if (/(?:\bstop-process\b|\bstart-process\b|\bstart-service\b|\bstop-service\b|\brestart-service\b|\btaskkill\b|(?:^|[\s;|&])kill(?:\s|$))/i.test(command)) return "manage_processes";
  if (/(?:\bget-process\b|\bwin32_process\b|\btasklist\b|(?:^|[\s;|&])ps(?:\s|$))/i.test(command)) return "inspect_processes";
  if (/(?:\bget-winevent\b|\bget-eventlog\b|\bjournalctl\b)/i.test(command)) return "inspect_logs";
  if (/(?:^|[\s;&|])reg(?:\.exe)?\s+query\b|\bget-itemproperty\b[^\r\n;]*registry::/i.test(command)) return "inspect_registry";
  if (/(?:\bget-pnpdevice\b|\bget-ciminstance\b[^\r\n;]*\bwin32_(?:sounddevice|videocontroller|usbcontroller)\b|\bffmpeg\b[^\r\n;]*\blist_devices\b)/i.test(command)) return "inspect_devices";
  if (/(?:\bget-(?:volume|disk|partition|physicaldisk|storagereliabilitycounter|bitlockervolume)\b|\bwin32_(?:logicaldisk|diskdrive|diskpartition|volume)\b|\bmanage-bde\b|\bdiskpart\b|\bfsutil\s+(?:dirty|volume|fsinfo)\b|\bwmic\s+diskdrive\b)/i.test(command)) return "inspect_storage";
  if (/(?:\bget-computerinfo\b|\bget-hotfix\b|\breagentc\s+\/info\b|\bsysteminfo\b)/i.test(command)) return "inspect_system";
  if (/(?:^|[\s;&|])get-date(?:\s|$)|(?:^|[\s;&|])date(?:\.exe)?(?:\s|$)/i.test(command)) return "time_lookup";
  if (/(?:\bget-command\b|\bget-variable\b|\bget-environmentvariable\b|\bget-childitem\s+env:|\$env:[A-Za-z_][A-Za-z0-9_]*)/i.test(command)) return "inspect_environment";
  if (/(?:\bget-filehash\b|\btest-path\b|\bget-itemproperty\b|\bget-item\b|(?:^|[\s;|&])stat(?:\s|$))/i.test(command)) return "inspect_files";
  const fileAction = firstFileAction(command);
  if (fileAction) return fileAction;
  if (/(?:\bconvertfrom-json\b|\bconvertto-json\b|\bconvertfrom-csv\b|\bconvertto-csv\b|\bparse\b)/i.test(command)) return "process_data";
  if (/(?:\bget-nettcpconnection\b|\btest-netconnection\b|\bnetstat\b|\btracert\b|(?:^|[\s;|&])ping(?:\.exe)?(?:\s|$)|\bnetsh\s+(?:winhttp|interface)\b|(?:^|[\s;|&])curl(?:\.exe)?(?:\s|$)|\binvoke-webrequest\b|\binvoke-restmethod\b)/i.test(command)) return "network_request";
  if (/(?:\bstart-sleep\b|(?:^|[\s;|&])sleep(?:\s|$))/i.test(command)) return "shell_wait";
  return "shell_command";
}
