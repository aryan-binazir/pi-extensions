import { realpathSync } from 'node:fs';
import { getAgentDir, ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { loadProfiles, profileGuidance } from './profiles.ts';

try {
  const args = process.argv.slice(2);
  let cwd = process.cwd();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--cwd' && args[i + 1] && !args[i + 1].startsWith('--')) cwd = args[++i];
    else if (args[i] === '--help') {
      console.log('Usage: show-config [--cwd PATH] [--json]\nReads bundled/global settings and local overrides only for a project with saved Pi trust. Does not change trust.');
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  cwd = realpathSync(cwd);
  const agentDir = getAgentDir();
  const config = loadProfiles(cwd, new ProjectTrustStore(agentDir).get(cwd) === true, agentDir);
  console.log(json ? JSON.stringify(config, null, 2) : `${profileGuidance(config)}\n\nSources: ${config.sources.join(', ')}\nLocal overrides: ${config.local}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
