import * as path from "path";

import { Analyzer, BlockCompiler, StyleMapping } from "@css-blocks/core";
import { TemplateTypes } from "@opticss/template-api";

import * as debugGenerator from "debug";
import * as fs from "fs-extra";
import * as FSTree from "fs-tree-diff";
import * as glob from "glob";
import { OptiCSSOptions, Optimizer, postcss } from "opticss";
import * as walkSync from "walk-sync";

import { Transport } from "./Transport";
import { BroccoliPlugin, symlinkOrCopy } from "./utils";

const debug = debugGenerator("css-blocks:broccoli");

export interface BroccoliOptions {
  entry: string[];
  output: string;
  root: string;
  analyzer: Analyzer<keyof TemplateTypes>;
  transport: Transport;
  optimization?: Partial<OptiCSSOptions>;
}

export class CSSBlocksAnalyze extends BroccoliPlugin {

  private analyzer: Analyzer<keyof TemplateTypes>;
  private entries: string[];
  private output: string;
  private root: string;
  private transport: Transport;
  private optimizationOptions: Partial<OptiCSSOptions>;
  private previous: FSTree = new FSTree();

  // tslint:disable-next-line:prefer-whatever-to-any
  constructor(inputNode: any, options: BroccoliOptions) {
    super([inputNode], {
      name: "broccoli-css-blocks-analyze",
      persistentOutput: true,
    });
    this.entries = options.entry.slice(0);
    this.output = options.output || "css-blocks.css";
    this.transport = options.transport;
    this.optimizationOptions = options.optimization || {};
    this.analyzer = options.analyzer;
    this.root = options.root || process.cwd();
    this.transport.css = this.transport.css ? this.transport.css : "";
  }

  async build() {
    let input = this.inputPaths[0];
    let output = this.outputPath;
    let options = this.analyzer.cssBlocksOptions;
    let blockCompiler = new BlockCompiler(postcss, options);
    let optimizer = new Optimizer(this.optimizationOptions, this.analyzer.optimizationOptions);

    // Test if anything has changed since last time. If not, skip all analysis work.
    let newFsTree = new FSTree({ entries: walkSync.entries(input) });
    let diff = this.previous.calculatePatch(newFsTree);
    if (!diff.length) { return; }
    this.previous = newFsTree;
    FSTree.applyPatch(input, output, diff);

    // When no entry points are passed, we treat *every* template as an entry point.
    this.entries = this.entries.length ? this.entries : glob.sync("**/*.hbs", { cwd: input });

    // The glimmer-analyzer package tries to require() package.json
    // in the root of the directory it is passed. We pass it our broccoli
    // tree, so it needs to contain package.json too.
    // TODO: Ideally this is configurable in glimmer-analyzer. We can
    //       contribute that option back to the project. However,
    //       other template integrations may want this available too...
    let pjsonLink = path.join(input, "package.json");
    if (!fs.existsSync(pjsonLink)) {
      symlinkOrCopy(path.join(this.root, "package.json"), pjsonLink);
    }

    // Oh hey look, we're analyzing.
    this.analyzer.reset();
    this.transport.reset();
    await this.analyzer.analyze(input, this.entries);

    // Compile all Blocks and add them as sources to the Optimizer.
    // TODO: handle a sourcemap from compiling the block file via a preprocessor.
    let blocks = this.analyzer.transitiveBlockDependencies();
    for (let block of blocks) {
      if (block.stylesheet) {
        let root = blockCompiler.compile(block, block.stylesheet, this.analyzer);
        let result = root.toResult({ to: this.output, map: { inline: false, annotation: false } });
        let filesystemPath = options.importer.filesystemPath(block.identifier, options);
        let filename = filesystemPath || options.importer.debugIdentifier(block.identifier, options);

        // If this Block has a representation on disk, remove it from our output tree.
        if (filesystemPath) {
          let outputStylesheet = path.join(output, path.relative(input, filesystemPath));
          debug(`Removing block file ${outputStylesheet} from output.`);
          if (fs.existsSync(outputStylesheet)) { fs.removeSync(outputStylesheet); }
        }

        // Add the compiled Block file to the optimizer.
        optimizer.addSource({
          content: result.css,
          filename,
          sourceMap: result.map.toJSON(),
        });
      }
    }

    // Add each Analysis to the Optimizer.
    this.analyzer.eachAnalysis((a) => optimizer.addAnalysis(a.forOptimizer(options)));

    // Run optimization and compute StyleMapping.
    let optimized = await optimizer.optimize(this.output);
    let styleMapping = new StyleMapping<keyof TemplateTypes>(optimized.styleMapping, blocks, options, this.analyzer.analyses());

    // Attach all computed data to our magic shared memory transport object...
    this.transport.mapping = styleMapping;
    this.transport.blocks = blocks;
    this.transport.analyzer = this.analyzer;
    this.transport.css += optimized.output.content.toString();

    debug(`Compilation Finished: ${this.transport.id}`);

  }

}
