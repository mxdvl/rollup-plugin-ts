import {TS} from "../../../../../type/ts";
import {visitNode} from "./visitor/visit-node";
import {
	ImportedSymbol,
	ImportedSymbolSet,
	TrackImportsOptions,
	TrackImportsTransformerVisitorOptions
} from "./track-imports-transformer-visitor-options";

export function trackImportsTransformer(options: TrackImportsOptions): TS.SourceFile {
	const {typescript} = options;
	const importedSymbolSet: ImportedSymbolSet = new Set();
	options.sourceFileToImportedSymbolSet.set(options.sourceFile.fileName, importedSymbolSet);

	// Prepare some VisitorOptions
	const visitorOptions: Omit<TrackImportsTransformerVisitorOptions<TS.Node>, "node"> = {
		...options,

		markAsImported(symbol: ImportedSymbol): void {
			importedSymbolSet.add(symbol);
		},

		childContinuation: <U extends TS.Node>(node: U): void =>
			typescript.forEachChild(node, nextNode => {
				visitNode({
					...visitorOptions,
					node: nextNode
				});
			}),

		continuation: <U extends TS.Node>(node: U): void => {
			visitNode({
				...visitorOptions,
				node
			});
		}
	};

	typescript.forEachChild(options.sourceFile, nextNode => {
		visitorOptions.continuation(nextNode);
	});
	return options.sourceFile;
}
