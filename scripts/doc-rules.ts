import { dirname, resolve } from 'node:path';
import { assert, read, regular } from './lib.ts';

export function fences(text: string, language: string): string[] {
  const re = new RegExp(
    '^' +
      '`'.repeat(3) +
      language +
      '\\n([\\s\\S]*?)^' +
      '`'.repeat(3) +
      '\\s*$',
    'gm',
  );
  return [...text.matchAll(re)].map((m) => m[1]!);
}
export function checkLinks(path: string): number {
  const text = read(path);
  let count = 0;
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const dest = decodeURIComponent(match[1]!).replace(/^<|>$/g, '');
    if (/^[a-z][a-z+.-]*:/i.test(dest)) continue;
    const [name, fragment] = dest.split('#');
    const target = name ? resolve(dirname(path), name) : path;
    assert(regular(target), path + ': missing link ' + dest);
    if (fragment) {
      const slugs = [...read(target).matchAll(/^#{1,6} (.*)$/gm)].map((m) =>
        m[1]!
          .toLowerCase()
          .replace(/[`*_]/g, '')
          .replace(/[^\p{L}\p{N} _-]/gu, '')
          .replaceAll(' ', '-'),
      );
      assert(slugs.includes(fragment), path + ': missing anchor ' + dest);
    }
    count++;
  }
  return count;
}
type RefConfig = {
  plugins: {
    ref: string;
    capabilities: string[];
    locations: string[];
    entry: string;
  }[];
  instances: {
    ref: string;
    packageRef: string;
    execution: { location: string };
    grantRef: string;
    budgetRef: string;
  }[];
  bindings: {
    id: string;
    instanceRef: string;
    capability: string;
    dependsOn: string[];
    trigger: { instanceRef: string };
    runPolicyRef: string;
    inputs?: {
      selector: {
        kind: string;
        producerBinding?: string;
        setKey?: string;
        slots?: string[] | 'all';
        version?: string;
      };
    }[];
    output?: { setKey: string };
    recipe?: { requiredOutputs: { slotKey: string }[] };
  }[];
  grants: Record<string, unknown>;
  budgets: Record<string, unknown>;
  runPolicies: Record<string, unknown>;
  retrieval: {
    indexer: string;
    embedding: string | null;
    retriever: string;
    assembler: string;
  };
};
export function checkScenario(value: unknown): void {
  // Full structural/type validation runs against the documented ScenarioConfig.
  // This pass checks cross-reference invariants that TypeScript cannot enforce.
  const cfg = value as RefConfig;
  const packages = new Map(cfg.plugins.map((p) => [p.ref, p]));
  const instances = new Map(cfg.instances.map((i) => [i.ref, i]));
  const bindings = new Map(cfg.bindings.map((b) => [b.id, b]));
  assert(
    packages.size === cfg.plugins.length &&
      instances.size === cfg.instances.length &&
      bindings.size === cfg.bindings.length,
    'duplicate ref',
  );
  function capability(ref: string, required: string): void {
    const instance = instances.get(ref);
    const pkg = instance && packages.get(instance.packageRef);
    assert(
      pkg?.capabilities.includes(required),
      'missing capability/ref: ' + ref + '/' + required,
    );
  }
  for (const instance of cfg.instances) {
    const pkg = packages.get(instance.packageRef);
    assert(
      pkg?.locations.includes(instance.execution.location),
      'package/location: ' + instance.ref,
    );
    assert(
      instance.grantRef in cfg.grants && instance.budgetRef in cfg.budgets,
      'grant/budget: ' + instance.ref,
    );
  }
  for (const binding of cfg.bindings) {
    capability(binding.instanceRef, binding.capability);
    capability(binding.trigger.instanceRef, 'trigger');
    assert(binding.runPolicyRef in cfg.runPolicies, 'run policy');
    for (const dep of binding.dependsOn)
      assert(bindings.has(dep), 'missing dependency ' + dep);
    for (const { selector } of binding.inputs ?? []) {
      if (selector.producerBinding)
        assert(
          binding.dependsOn.includes(selector.producerBinding),
          'undeclared producer',
        );
      if (selector.kind !== 'output-set') continue;
      const producer = bindings.get(selector.producerBinding!);
      assert(
        producer?.output?.setKey === selector.setKey,
        'output set reference',
      );
      const slots =
        producer?.recipe?.requiredOutputs.map((s) => s.slotKey) ?? [];
      assert(
        selector.slots === 'all' ||
          selector.slots?.every((s) => slots.includes(s)),
        'missing output slot',
      );
      assert(
        selector.version === 'formal-at-snapshot',
        'formal selector version',
      );
      assert(
        !('collections' in selector) && !('pathPrefix' in selector),
        'promotion cannot filter by derived path',
      );
    }
  }
  function visit(id: string, ancestors: string[]): void {
    assert(!ancestors.includes(id), 'binding cycle');
    for (const dep of bindings.get(id)!.dependsOn)
      visit(dep, [...ancestors, id]);
  }
  for (const id of bindings.keys()) visit(id, []);
  for (const [key, cap] of [
    ['indexer', 'indexer'],
    ['embedding', 'embedding'],
    ['retriever', 'retriever'],
    ['assembler', 'context-assembler'],
  ] as const) {
    const ref = cfg.retrieval[key];
    if (ref) capability(ref, cap);
  }
}
