import {TS} from "../../../../../type/ts";
import {SourceFileBundlerVisitorOptions} from "../source-file-bundler/source-file-bundler-visitor-options";
import {visitNode} from "./visitor/visit-node";

export function ensureNoExportModifierTransformer({typescript, context, ...options}: SourceFileBundlerVisitorOptions): TS.SourceFile {
	if (options.pluginOptions.debug) {
		console.log(`=== BEFORE ENSURING NO EXPORT MODIFIERS === (${options.sourceFile.fileName})`);
		console.log(options.printer.printFile(options.sourceFile));
	}

	// Prepare some VisitorOptions
	const visitorOptions = {
		...options,
		context,
		typescript,

		childContinuation: <U extends TS.Node>(node: U): U =>
			typescript.visitEachChild(
				node,
				nextNode =>
					visitNode({
						...visitorOptions,
						node: nextNode
					}),
				context
			),

		continuation: <U extends TS.Node>(node: U): U =>
			visitNode({
				...visitorOptions,
				node
			}) as U
	};

	const result = typescript.visitEachChild(options.sourceFile, nextNode => visitorOptions.continuation(nextNode), context);

	if (options.pluginOptions.debug) {
		console.log(`=== AFTER ENSURING NO EXPORT MODIFIERS === (${options.sourceFile.fileName})`);
		console.log(options.printer.printFile(result));
	}

	return result;
}