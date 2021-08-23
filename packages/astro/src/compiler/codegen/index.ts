import type { Ast, Script, Style, TemplateNode, Expression } from '@astrojs/parser';
import type { CompileOptions } from '../../@types/compiler';
import type { AstroConfig, TransformResult, ComponentInfo, Components } from '../../@types/astro';
import type { ImportDeclaration, ExportNamedDeclaration, VariableDeclarator, Identifier, ImportDefaultSpecifier } from '@babel/types';
import type { Attribute } from './interfaces';
import eslexer from 'es-module-lexer';
import esbuild from 'esbuild';
import path from 'path';
import astroParser from '@astrojs/parser';
import { walk, asyncWalk } from 'estree-walker';
import _babelGenerator from '@babel/generator';
import babelParser from '@babel/parser';
import { codeFrameColumns } from '@babel/code-frame';
import * as babelTraverse from '@babel/traverse';
import { error, warn, parseError } from '../../logger.js';
import { yellow } from 'kleur/colors';
import { isComponentTag, isCustomElementTag, positionAt } from '../utils.js';
import { warnIfRelativeStringLiteral } from './utils.js';
import { renderMarkdown } from '@astrojs/markdown-support';
import { camelCase } from 'camel-case';
import { transform } from '../transform/index.js';
import { PRISM_IMPORT } from '../transform/prism.js';
import { nodeBuiltinsSet } from '../../node_builtins.js';
import { readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const { parse, FEATURE_CUSTOM_ELEMENT } = astroParser;
const traverse: typeof babelTraverse.default = (babelTraverse.default as any).default;

// @ts-ignore
const babelGenerator: typeof _babelGenerator = _babelGenerator.default;
const { transformSync } = esbuild;

const hydrationDirectives = new Set(['client:load', 'client:idle', 'client:visible', 'client:media', 'client:only']);

interface CodeGenOptions {
  compileOptions: CompileOptions;
  filename: string;
  fileID: string;
}

interface HydrationAttributes {
  method?: 'load' | 'idle' | 'visible' | 'media' | 'only';
  value?: undefined | string;
}

/** Searches through attributes to extract hydration-rlated attributes */
function findHydrationAttributes(attrs: Record<string, string>): HydrationAttributes {
  let method: HydrationAttributes['method'];
  let value: undefined | string;

  for (const [key, val] of Object.entries(attrs)) {
    if (hydrationDirectives.has(key)) {
      method = key.slice(7) as HydrationAttributes['method'];
      value = val === 'true' ? undefined : val;
    }
  }

  return { method, value };
}

/** Retrieve attributes from TemplateNode */
async function getAttributes(nodeName: string, attrs: Attribute[], state: CodegenState, compileOptions: CompileOptions): Promise<Record<string, string>> {
  const isPage = state.filename.startsWith(fileURLToPath(compileOptions.astroConfig.pages));
  let result: Record<string, string> = {};
  for (const attr of attrs) {
    if (attr.type === 'Spread') {
      const code = await compileExpression(attr.expression as Expression, state, compileOptions);
      if (code) {
        result[`...(${code})`] = '';
      }
      continue;
    }
    if (attr.value === true) {
      result[attr.name] = JSON.stringify(attr.value);
      continue;
    }
    if (attr.value === false || attr.value === undefined) {
      // note: attr.value shouldn’t be `undefined`, but a bad transform would cause a compile error here, so prevent that
      continue;
    }
    if (attr.value.length === 0) {
      result[attr.name] = '""';
      continue;
    }
    if (attr.value.length > 1) {
      result[attr.name] =
        '(' +
        attr.value
          .map((v: TemplateNode) => {
            if (v.content) {
              return v.content;
            } else {
              return JSON.stringify(getTextFromAttribute(v));
            }
          })
          .join('+') +
        ')';
      continue;
    }
    const val = attr.value[0];
    if (!val) {
      result[attr.name] = '(' + val + ')';
      continue;
    }
    switch (val.type) {
      case 'MustacheTag': {
        const code = await compileExpression(val.expression, state, compileOptions);
        if (code) {
          result[attr.name] = '(' + code + ')';
        }
        continue;
      }
      case 'Text': {
        let text = getTextFromAttribute(val);
        if (!isPage) {
          warnIfRelativeStringLiteral(compileOptions.logging, nodeName, attr, text);
        }
        result[attr.name] = JSON.stringify(text);
        continue;
      }
      case 'AttributeShorthand':
        result[attr.name] = '(' + attr.name + ')';
        continue;
      default:
        throw new Error(`UNKNOWN: ${val.type}`);
    }
  }
  return result;
}

/** Get value from a TemplateNode Attribute (text attributes only!) */
function getTextFromAttribute(attr: any): string {
  switch (attr.type) {
    case 'Text': {
      if (attr.raw !== undefined) {
        return attr.raw;
      }
      if (attr.data !== undefined) {
        return attr.data;
      }
      break;
    }
    case 'MustacheTag': {
      // FIXME: this won't work when JSX element can appear in attributes (rare but possible).
      return attr.expression.codeChunks[0];
    }
  }
  throw new Error(`Unknown attribute type ${attr.type}`);
}

/** Convert TemplateNode attributes to string */
function generateAttributes(attrs: Record<string, string>): string {
  let result = '{';
  for (const [key, val] of Object.entries(attrs)) {
    if (hydrationDirectives.has(key)) {
      continue;
    } else if (key.startsWith('...')) {
      result += key + ',';
    } else {
      result += JSON.stringify(key) + ':' + val + ',';
    }
  }
  result += `[__astroContext]:props[__astroContext]`;
  return result + '}';
}

function getComponentUrl(astroConfig: AstroConfig, url: string, parentUrl: string | URL) {
  const componentExt = path.extname(url);
  const ext = PlainExtensions.has(componentExt) ? '.js' : `${componentExt}.js`;
  const outUrl = new URL(url, parentUrl);
  return '/_astro/' + outUrl.href.replace(astroConfig.projectRoot.href, '').replace(/\.[^.]+$/, ext);
}

interface GetComponentWrapperOptions {
  filename: string;
  astroConfig: AstroConfig;
  compileOptions: CompileOptions;
}

const PlainExtensions = new Set(['.js', '.jsx', '.ts', '.tsx']);
/** Generate Astro-friendly component import */
function getComponentWrapper(_name: string, hydration: HydrationAttributes, { url, importSpecifier }: ComponentInfo, opts: GetComponentWrapperOptions) {
  const { astroConfig, filename, compileOptions } = opts;

  let name = _name;
  let method = hydration.method;

  /** Legacy support for original hydration syntax */
  if (name.indexOf(':') > 0) {
    const [legacyName, legacyMethod] = _name.split(':');
    name = legacyName;
    method = legacyMethod as HydrationAttributes['method'];

    const shortname = path.posix.relative(compileOptions.astroConfig.projectRoot.pathname, filename);
    warn(compileOptions.logging, shortname, yellow(`Deprecation warning: Partial hydration now uses a directive syntax. Please update to "<${name} client:${method} />"`));
  }

  // Special flow for custom elements
  if (isCustomElementTag(_name)) {
    return {
      wrapper: `__astro_component(...__astro_element_registry.astroComponentArgs("${name}", ${JSON.stringify({ hydrate: method, displayName: _name })}))`,
      wrapperImports: [
        `import {AstroElementRegistry} from 'astro/dist/internal/element-registry.js';`,
        `import {__astro_component} from 'astro/dist/internal/__astro_component.js';`,
      ],
    };
  } else {
    const getComponentExport = () => {
      switch (importSpecifier.type) {
        case 'ImportDefaultSpecifier':
          return { value: 'default' };
        case 'ImportSpecifier': {
          if (importSpecifier.imported.type === 'Identifier') {
            return { value: importSpecifier.imported.name };
          }
          return { value: importSpecifier.imported.value };
        }
        case 'ImportNamespaceSpecifier': {
          const [_, value] = _name.split('.');
          return { value };
        }
      }
    };

    let metadata: string = '';
    if (method) {
      const componentUrl = getComponentUrl(astroConfig, url, pathToFileURL(filename));
      const componentExport = getComponentExport();
      metadata = `{ hydrate: "${method}", displayName: "${name}", componentUrl: "${componentUrl}", componentExport: ${JSON.stringify(componentExport)}, value: ${
        hydration.value || 'null'
      } }`;

      // for client:only components, only render a Fragment on the server
      if (method === 'only') {
        name = 'Fragment';
      }
    } else {
      metadata = `{ hydrate: undefined, displayName: "${name}", value: ${hydration.value || 'null'} }`;
    }

    return {
      wrapper: `__astro_component(${name}, ${metadata})`,
      wrapperImports: [`import {__astro_component} from 'astro/dist/internal/__astro_component.js';`],
    };
  }
}

/**
 * Convert an Expression Node to a string
 *
 * @param expression Expression Node to compile
 * @param state CodegenState
 * @param compileOptions CompileOptions
 */
async function compileExpression(node: Expression, state: CodegenState, compileOptions: CompileOptions) {
  const children: string[] = await Promise.all((node.children ?? []).map((child) => compileHtml(child, state, compileOptions)));
  let raw = '';
  let nextChildIndex = 0;
  for (const chunk of node.codeChunks) {
    raw += chunk;
    if (nextChildIndex < children.length) {
      raw += children[nextChildIndex++];
    }
  }
  const location = { start: node.start, end: node.end };
  let code = transpileExpressionSafe('(' + raw + ')', { state, compileOptions, location });
  if (code === null) throw new Error(`Unable to compile expression`);
  code = code.trim().replace(/\;$/, '');
  return code;
}

/** Evaluate expression (safely) */
function transpileExpressionSafe(
  raw: string,
  { state, compileOptions, location }: { state: CodegenState; compileOptions: CompileOptions; location: { start: number; end: number } }
): string | null {
  try {
    let { code } = transformSync(raw, {
      loader: 'tsx',
      jsxFactory: 'h',
      jsxFragment: 'Fragment',
      charset: 'utf8',
    });
    return code;
  } catch ({ errors }) {
    const err = new Error() as any;
    const e = errors[0];
    err.filename = state.filename;
    const text = readFileSync(state.filename).toString();
    const start = positionAt(location.start, text);
    start.line += e.location.line;
    start.character += e.location.column + 1;
    err.start = { line: start.line, column: start.character };

    const end = { ...start };
    end.character += e.location.length;

    const frame = codeFrameColumns(text, {
      start: { line: start.line, column: start.character },
      end: { line: end.line, column: end.character },
    });

    err.frame = frame;
    err.message = e.text;
    parseError(compileOptions.logging, err);
    return null;
  }
}

interface CompileResult {
  script: string;
  getStaticPaths?: string;
}

interface CodegenState {
  components: Components;
  css: string[];
  filename: string;
  fileID: string;
  markers: {
    insideMarkdown: boolean | Record<string, any>;
  };
  declarations: Set<string>;
  exportStatements: Set<string>;
  importStatements: Set<string>;
  componentImports: Map<string, string[]>;
  customElementCandidates: Map<string, string>;
}

/** Compile/prepare Astro frontmatter scripts */
function compileModule(ast: Ast, module: Script, state: CodegenState, compileOptions: CompileOptions): CompileResult {
  const { astroConfig } = compileOptions;
  const { filename } = state;
  const componentImports: ImportDeclaration[] = [];
  const componentProps: VariableDeclarator[] = [];
  const componentExports: ExportNamedDeclaration[] = [];

  let script = '';
  let propsStatement = '';
  let getStaticPaths = ''; // function for executing collection

  if (module) {
    const parseOptions: babelParser.ParserOptions = {
      sourceType: 'module',
      plugins: ['jsx', 'typescript', 'topLevelAwait', 'throwExpressions'],
    };
    let parseResult;
    try {
      parseResult = babelParser.parse(module.content, parseOptions);
    } catch (err) {
      const location = { start: err.loc };
      const frame = codeFrameColumns(module.content, location);
      err.frame = frame;
      err.filename = state.filename;
      err.start = err.loc;
      throw err;
    }

    // Convert Astro.fetchContent() to use import.meta.glob
    if (/Astro\s*\.\s*fetchContent/.test(module.content)) {
      state.importStatements.add(`import {fetchContent} from 'astro/dist/internal/fetch-content.js';\n`);
      traverse(parseResult, {
        enter({ node }) {
          if (
            node.type !== 'CallExpression' ||
            node.callee.type !== 'MemberExpression' ||
            (node.callee.object as any).name !== 'Astro' ||
            (node.callee.property as any).name !== 'fetchContent'
          ) {
            return;
          }
          if (node.arguments[0].type !== 'StringLiteral') {
            throw new Error(`[Astro.fetchContent] Only string literals allowed, ex: \`Astro.fetchContent('./post/*.md')\`\n  ${state.filename}`);
          }
          // Replace `Astro.fetchContent(str)` with `Astro.fetchContent(import.meta.globEager(str))`
          node.arguments = [
            {
              type: 'CallExpression',
              callee: {
                type: 'MemberExpression',
                object: { type: 'MetaProperty', meta: { type: 'Identifier', name: 'import' }, property: { type: 'Identifier', name: 'meta' } },
                property: { type: 'Identifier', name: 'globEager' },
                computed: false,
              },
              arguments: node.arguments,
            },
          ] as any;
        },
      });
    }

    const program = parseResult.program;
    const { body } = program;
    let i = body.length;
    while (--i >= 0) {
      const node = body[i];
      switch (node.type) {
        // case 'ExportAllDeclaration':
        // case 'ExportDefaultDeclaration':
        case 'ExportNamedDeclaration': {
          if (!node.declaration) break;

          if (node.declaration.type === 'VariableDeclaration') {
            // case 1: prop (export let title)

            const declaration = node.declaration.declarations[0];
            if ((declaration.id as Identifier).name === '__layout' || (declaration.id as Identifier).name === '__content') {
              componentExports.push(node);
            } else {
              componentProps.push(declaration);
            }
          } else if (node.declaration.type === 'FunctionDeclaration') {
            // case 2: getStaticPaths (export async function)
            if (!node.declaration.id || node.declaration.id.name !== 'getStaticPaths') break;
            getStaticPaths = babelGenerator(node).code;
          }

          body.splice(i, 1);
          break;
        }
        case 'FunctionDeclaration': {
          if (node.id?.name) {
            state.declarations.add(node.id?.name);
          }
          break;
        }
        case 'ImportDeclaration': {
          componentImports.push(node);
          body.splice(i, 1); // remove node
          break;
        }
        case 'VariableDeclaration': {
          // Support frontmatter-defined components
          for (const declaration of node.declarations) {
            if (declaration.id.type === 'Identifier') {
              state.declarations.add(declaration.id.name);
            }
          }
          break;
        }
      }
    }

    for (const componentImport of componentImports) {
      const importUrl = componentImport.source.value;
      if (nodeBuiltinsSet.has(importUrl)) {
        throw new Error(`Node builtins must be prefixed with 'node:'. Use node:${importUrl} instead.`);
      }
      for (const specifier of componentImport.specifiers) {
        const componentName = specifier.local.name;
        state.components.set(componentName, {
          importSpecifier: specifier,
          url: importUrl,
        });
        if (!state.componentImports.has(componentName)) {
          state.componentImports.set(componentName, []);
        }

        // Track component imports to be used for server-rendered components
        const { start, end } = componentImport;
        state.componentImports.get(componentName)?.push(module.content.slice(start || undefined, end || undefined));
      }
      const { start, end } = componentImport;
      if (ast.meta.features & FEATURE_CUSTOM_ELEMENT && componentImport.specifiers.length === 0) {
        // Add possible custom element, but only if the AST says there are custom elements.
        const moduleImportName = camelCase(importUrl + 'Module');
        state.importStatements.add(`import * as ${moduleImportName} from '${importUrl}';\n`);
        state.customElementCandidates.set(moduleImportName, getComponentUrl(astroConfig, importUrl, pathToFileURL(filename)));
      } else {
        state.importStatements.add(module.content.slice(start || undefined, end || undefined));
      }
    }

    // TODO: actually expose componentExports other than __layout and __content
    for (const componentImport of componentExports) {
      const { start, end } = componentImport;
      state.exportStatements.add(module.content.slice(start || undefined, end || undefined));
    }

    if (componentProps.length > 0) {
      const shortname = path.posix.relative(compileOptions.astroConfig.projectRoot.pathname, state.filename);
      const props = componentProps.map((prop) => (prop.id as Identifier)?.name).filter((v) => v);
      warn(
        compileOptions.logging,
        shortname,
        yellow(`\nDefining props with "export" has been removed! Please see https://github.com/snowpackjs/astro/blob/main/packages/astro/CHANGELOG.md#0150
Please update your code to use:

const { ${props.join(', ')} } = Astro.props;\n`)
      );
    }

    script = propsStatement + babelGenerator(program).code;
    const location = { start: module.start, end: module.end };
    let transpiledScript = transpileExpressionSafe(script, { state, compileOptions, location });
    if (transpiledScript === null) throw new Error(`Unable to compile script`);
    script = transpiledScript;
  }

  return {
    script,
    getStaticPaths: getStaticPaths || undefined,
  };
}

/** Compile styles */
function compileCss(style: Style, state: CodegenState) {
  walk(style, {
    enter(node: TemplateNode) {
      if (node.type === 'Style') {
        state.css.push(node.content.styles); // if multiple <style> tags, combine together
        this.skip();
      }
    },
    leave(node: TemplateNode) {
      if (node.type === 'Style') {
        this.remove(); // this will be optimized in a global CSS file; remove so it‘s not accidentally inlined
      }
    },
  });
}

/** dedent markdown */
function dedent(str: string) {
  let arr = str.match(/^[ \t]*(?=\S)/gm);
  let first = !!arr && arr.find((x) => x.length > 0)?.length;
  return !arr || !first ? str : str.replace(new RegExp(`^[ \\t]{0,${first}}`, 'gm'), '');
}

const FALSY_EXPRESSIONS = new Set(['false', 'null', 'undefined', 'void 0']);

function isFrontmatterDefinedComponent(componentName: string, componentInfo: ComponentInfo | undefined, state: CodegenState) {
  let hasVariableDeclaration = state.declarations.has(componentName);
  let isNotImported = !componentInfo;

  return hasVariableDeclaration && isNotImported;
}

function isFragmentComponent(componentName: string) {
  return componentName === 'Fragment';
}

/** Compile page markup */
async function compileHtml(enterNode: TemplateNode, state: CodegenState, compileOptions: CompileOptions): Promise<string> {
  return new Promise((resolve) => {
    const { components, css, importStatements, exportStatements, filename, fileID } = state;
    const { astroConfig } = compileOptions;

    let paren = -1;
    let buffers = {
      out: '',
      markdown: '',
    };
    let curr: keyof typeof buffers = 'out';

    /** renders markdown stored in `buffers.markdown` to JSX and pushes that to `buffers.out` */
    async function pushMarkdownToBuffer() {
      const md = buffers.markdown;
      const { markdownOptions = {} } = astroConfig;
      if (!md.trim()) {
        buffers.out += ',' + md;
        buffers.markdown = '';
        curr = 'out';
        return;
      }
      const { $scope: scopedClassName } = state.markers.insideMarkdown as Record<'$scope', any>;
      let { content: rendered } = await renderMarkdown(dedent(md), {
        ...markdownOptions,
        $: { scopedClassName: scopedClassName && scopedClassName.slice(1, -1) },
      });

      // 1. Parse
      const ast = parse(rendered);
      // 2. Transform the AST

      await transform(ast, {
        compileOptions,
        filename,
        fileID,
      });

      // 3. Codegen
      const result = await compileHtml(ast.html, { ...state, markers: { insideMarkdown: false } }, compileOptions);

      buffers.out += ',' + result;
      buffers.markdown = '';
      curr = 'out';
    }

    asyncWalk(enterNode, {
      async enter(node: TemplateNode, parent: TemplateNode) {
        switch (node.type) {
          case 'Expression': {
            let code = await compileExpression(node as Expression, state, compileOptions);
            if (FALSY_EXPRESSIONS.has(code)) {
              this.skip();
              break;
            }
            if (code !== '') {
              if (state.markers.insideMarkdown) {
                buffers[curr] += `{${code}}`;
              } else {
                buffers[curr] += `,(${code})`;
              }
            }
            this.skip();
            break;
          }
          case 'MustacheTag':
            if (state.markers.insideMarkdown) {
              if (curr === 'out') curr = 'markdown';
            }
            return;
          case 'Comment':
            return;
          case 'Fragment': {
            buffers[curr] += `h(Fragment, null,`;
            break;
          }
          case 'SlotTemplate': {
            buffers[curr] += `h(Fragment, null, children`;
            paren++;
            return;
          }
          case 'Slot':
          case 'Head':
          case 'InlineComponent': {
            switch (node.name) {
              case 'Prism': {
                if (!importStatements.has(PRISM_IMPORT)) {
                  importStatements.add(PRISM_IMPORT);
                }
                if (!components.has('Prism')) {
                  components.set('Prism', {
                    importSpecifier: {
                      type: 'ImportDefaultSpecifier',
                      local: { type: 'Identifier', name: 'Prism' } as Identifier,
                    } as ImportDefaultSpecifier,
                    url: 'astro/components/Prism.astro',
                  });
                }
                break;
              }
            }
            // Do not break.
          }
          case 'Title':
          case 'Element': {
            const name: string = node.name;
            if (!name) {
              throw new Error('AHHHH');
            }
            try {
              const attributes = await getAttributes(name, node.attributes, state, compileOptions);
              const hydrationAttributes = findHydrationAttributes(attributes);

              buffers.out += buffers.out === '' ? '' : ',';

              if (node.type === 'Slot') {
                state.importStatements.add(`import { __astro_slot } from 'astro/dist/internal/__astro_slot.js';`);
                buffers[curr] += `h(__astro_slot, ${generateAttributes(attributes)}, children`;
                paren++;
                return;
              }
              if (!isComponentTag(name)) {
                if (curr === 'markdown') {
                  await pushMarkdownToBuffer();
                }
                if (attributes.slot) {
                  state.importStatements.add(`import { __astro_slot_content } from 'astro/dist/internal/__astro_slot.js';`);
                  buffers[curr] += `h(__astro_slot_content, { name: ${attributes.slot} },`;
                  paren++;
                }
                buffers[curr] += `h("${name}", ${generateAttributes(attributes)},`;
                paren++;
                return;
              }
              const [componentName, _componentKind] = name.split(':');
              let componentInfo = components.get(componentName);
              if (/\./.test(componentName)) {
                const [componentNamespace] = componentName.split('.');
                componentInfo = components.get(componentNamespace);
              }
              if ((isFrontmatterDefinedComponent(componentName, componentInfo, state) && !isCustomElementTag(componentName)) || isFragmentComponent(componentName)) {
                if (hydrationAttributes.method) {
                  throw new Error(
                    `Unable to hydrate "${componentName}" because it is statically defined in the frontmatter script. Hydration directives may only be used on imported components.`
                  );
                }

                // Previously we would throw here, but this is valid!
                // If the frontmatter script defines `const Element = 'h1'`,
                // you should be able to statically render `<Element>`

                if (curr === 'markdown') {
                  await pushMarkdownToBuffer();
                }

                if (attributes.slot) {
                  state.importStatements.add(`import { __astro_slot_content } from 'astro/dist/internal/__astro_slot.js';`);
                  buffers[curr] += `h(__astro_slot_content, { name: ${attributes.slot} },`;
                  paren++;
                }
                buffers[curr] += `h(${componentName}, ${generateAttributes(attributes)},`;
                paren++;
                return;
              } else if (!componentInfo && !isCustomElementTag(componentName)) {
                throw new Error(`Unable to render "${componentName}" because it is undefined\n  ${state.filename}`);
              }
              if (componentName === 'Markdown') {
                const { $scope } = attributes ?? {};
                state.markers.insideMarkdown = typeof state.markers.insideMarkdown === 'object' ? { $scope, count: state.markers.insideMarkdown.count + 1 } : { $scope, count: 1 };
                const keys = Object.keys(attributes).filter((attr) => attr !== '$scope');
                if (keys.length > 0) {
                  if (curr === 'markdown') {
                    await pushMarkdownToBuffer();
                  }
                  buffers[curr] += `,${componentName}.__render(${generateAttributes(attributes)}),`;
                }
                curr = 'markdown';
                return;
              }
              const { wrapper, wrapperImports } = getComponentWrapper(name, hydrationAttributes, componentInfo ?? ({} as any), { astroConfig, filename, compileOptions });
              if (wrapperImports) {
                for (let wrapperImport of wrapperImports) {
                  importStatements.add(wrapperImport);
                }
              }
              if (hydrationAttributes.method === 'only') {
                // Remove component imports for client-only components
                const componentImports = state.componentImports.get(componentName) || [];
                componentImports.map((componentImport) => state.importStatements.delete(componentImport));
              }
              if (curr === 'markdown') {
                await pushMarkdownToBuffer();
              }

              if (attributes.slot) {
                state.importStatements.add(`import { __astro_slot_content } from 'astro/dist/internal/__astro_slot.js';`);
                buffers[curr] += `h(__astro_slot_content, { name: ${attributes.slot} },`;
                paren++;
              }
              paren++;
              buffers[curr] += `h(${wrapper}, ${generateAttributes(attributes)}`;
            } catch (err) {
              paren--;
              // handle errors in scope with filename
              const rel = filename.replace(astroConfig.projectRoot.pathname, '');
              // TODO: return actual codeframe here
              error(compileOptions.logging, rel, err.toString());
            }
            return;
          }
          case 'Attribute':
          case 'Spread': {
            this.skip();
            return;
          }
          case 'Style': {
            css.push(node.content.styles); // if multiple <style> tags, combine together
            this.skip();
            return;
          }
          case 'CodeSpan':
          case 'CodeFence': {
            if (state.markers.insideMarkdown) {
              if (curr === 'out') curr = 'markdown';
              buffers[curr] += node.raw;
              return;
            }
            buffers[curr] += ',' + JSON.stringify(node.data);
            return;
          }
          case 'Text': {
            let text = getTextFromAttribute(node);
            if (state.markers.insideMarkdown) {
              if (curr === 'out') curr = 'markdown';
              buffers[curr] += text;
              return;
            }
            if (parent.name !== 'Markdown' && !text.trim()) {
              return;
            }
            if (parent.name === 'code') {
              // Special case, escaped { characters from markdown content
              text = node.raw.replace(/ASTRO_ESCAPED_LEFT_CURLY_BRACKET\0/g, '{');
            }
            buffers[curr] += ',' + JSON.stringify(text);
            return;
          }
          default:
            throw new Error('Unexpected (enter) node type: ' + node.type);
        }
      },
      async leave(node, parent, prop, index) {
        switch (node.type) {
          case 'Fragment': {
            buffers[curr] += `)`;
            break;
          }
          case 'Text':
          case 'Attribute':
          case 'Spread':
          case 'Comment':
          case 'Expression':
          case 'MustacheTag':
          case 'CodeSpan':
          case 'CodeFence':
            return;
          case 'SlotTemplate':
          case 'Slot':
          case 'Head':
          case 'Body':
          case 'Title':
          case 'Element': {
            if (curr === 'markdown') {
              await pushMarkdownToBuffer();
            }
            if (node.attributes.find((attr: any) => attr.name === 'slot')) {
              buffers.out += ')';
              paren--;
            }
            if (paren !== -1) {
              buffers.out += ')';
              paren--;
            }
            return;
          }
          case 'InlineComponent': {
            if (node.name === 'Markdown') {
              (state.markers.insideMarkdown as Record<string, any>).count--;
              if ((state.markers.insideMarkdown as Record<string, any>).count <= 0) {
                state.markers.insideMarkdown = false;
              }
              const hasAttrs = node.attributes.filter(({ name }: Attribute) => name !== '$scope').length > 0;
              if (hasAttrs) {
                return;
              }
            }
            if (curr === 'markdown' && buffers.markdown !== '') {
              await pushMarkdownToBuffer();
              if (!state.markers.insideMarkdown) {
                return;
              }
            }
            if (node.attributes.find((attr: any) => attr.name === 'slot')) {
              buffers.out += ')';
              paren--;
            }
            if (paren !== -1) {
              buffers.out += ')';
              paren--;
            }
            return;
          }
          case 'Style': {
            this.remove(); // this will be optimized in a global CSS file; remove so it‘s not accidentally inlined
            return;
          }
          default:
            throw new Error('Unexpected (leave) node type: ' + node.type);
        }
      },
    }).then(() => {
      const content = buffers.out.replace(/^\,/, '').replace(/\,\)/g, ')').replace(/\,+/g, ',').replace(/\)h/g, '),h');
      buffers.out = '';
      buffers.markdown = '';
      return resolve(content);
    });
  });
}

/**
 * Codegen
 * Step 3/3 in Astro SSR.
 * This is the final pass over a document AST before it‘s converted to an h() function
 * and handed off to Snowpack to build.
 * @param {Ast} AST The parsed AST to crawl
 * @param {object} CodeGenOptions
 */
export async function codegen(ast: Ast, { compileOptions, filename, fileID }: CodeGenOptions): Promise<TransformResult> {
  await eslexer.init;

  const state: CodegenState = {
    filename,
    fileID,
    components: new Map(),
    css: [],
    markers: {
      insideMarkdown: false,
    },
    declarations: new Set(),
    importStatements: new Set(),
    exportStatements: new Set(),
    componentImports: new Map(),
    customElementCandidates: new Map(),
  };

  const { script, getStaticPaths } = compileModule(ast, ast.module, state, compileOptions);

  (ast.css || []).map((css) => compileCss(css, state));

  const html = await compileHtml(ast.html, state, compileOptions);

  return {
    script: script,
    imports: Array.from(state.importStatements),
    exports: Array.from(state.exportStatements),
    html,
    css: state.css.length ? state.css.join('\n\n') : undefined,
    getStaticPaths,
    hasCustomElements: Boolean(ast.meta.features & FEATURE_CUSTOM_ELEMENT),
    customElementCandidates: state.customElementCandidates,
  };
}
