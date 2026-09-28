// Bundle Monaco locally so the editor works offline in the packaged Electron app
// (the default @monaco-editor/react loader fetches Monaco from a CDN).
//
// Import the CORE editor API plus the Monarch "basic languages" (which include
// YAML highlighting) rather than the full `monaco-editor` entry — that avoids
// pulling in the heavy JSON/CSS/HTML/TypeScript language services and their
// workers (the TS worker alone is ~7 MB) that a YAML editor never needs.
//
// NOTE: monaco's package `exports` maps "./*" -> "./esm/vs/*.js", so subpaths are
// written as `monaco-editor/editor/...`, NOT `monaco-editor/esm/vs/editor/...`.
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/basic-languages/monaco.contribution';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';

// YAML uses only a Monarch tokenizer (no language worker); the base editor worker
// is all we need.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

loader.config({ monaco });

export default monaco;
