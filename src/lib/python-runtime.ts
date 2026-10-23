import os from 'os';
import path from 'path';

import { buildExecutableCandidates, resolveExecutable } from './command-runtime.ts';

export interface ResolvedPythonCommand {
  command: string;
  argsPrefix: string[];
}

let resolvedPythonCommandPromise: Promise<ResolvedPythonCommand> | null = null;

function getPythonCandidates(): string[] {
  const home = os.homedir();
  return buildExecutableCandidates(
    [
      process.env.ANNOT_PYTHON_BIN,
      process.env.PYTHON_BIN,
      process.env.PYTHON,
    ],
    'python',
    [
      path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python'),
      path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python'),
      path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python'),
      path.join(home, 'miniconda3', 'python'),
      path.join(home, 'anaconda3', 'python'),
      path.join('/usr/local/bin', 'python3'),
      path.join('/opt/homebrew/bin', 'python3'),
      path.join('/usr/bin', 'python3'),
      path.join(process.env.SystemRoot || 'C:\\Windows', 'py'),
    ],
  );
}

async function resolvePythonCommand(): Promise<ResolvedPythonCommand> {
  const candidates = [
    ...buildExecutableCandidates(
      [
        process.env.ANNOT_PYTHON_BIN,
        process.env.PYTHON_BIN,
      ],
      'python3',
      [],
    ),
    ...getPythonCandidates(),
    ...buildExecutableCandidates(
      [
        process.env.ANNOT_PYTHON_LAUNCHER,
      ],
      'py',
      [
        path.join(process.env.SystemRoot || 'C:\\Windows', 'py'),
      ],
    ),
  ];

  const executable = await resolveExecutable([...new Set(candidates)]);
  if (!executable) {
    throw new Error(
      'Could not find a Python 3 executable. Set ANNOT_PYTHON_BIN to the full path to python if needed.',
    );
  }

  if (/([\\/]|^)py(\.exe)?$/i.test(executable)) {
    return {
      command: executable,
      argsPrefix: ['-3'],
    };
  }

  return {
    command: executable,
    argsPrefix: [],
  };
}

// Resolved once per server process and shared by every Python worker (annotations, PDF editing).
export function getPythonCommand(): Promise<ResolvedPythonCommand> {
  if (!resolvedPythonCommandPromise) {
    resolvedPythonCommandPromise = resolvePythonCommand();
  }
  return resolvedPythonCommandPromise;
}
