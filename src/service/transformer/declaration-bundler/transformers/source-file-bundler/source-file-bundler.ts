import type {DeclarationBundlerOptions, DeclarationTransformer} from "../../declaration-bundler-options.js";
import type {TS} from "../../../../../type/ts.js";
import {applyTransformers} from "../../util/apply-transformers.js";
import {getChunkFilename} from "../../util/get-chunk-filename.js";
import type {SourceFileBundlerVisitorOptions} from "./source-file-bundler-visitor-options.js";
import {formatLibReferenceDirective} from "../../util/format-lib-reference-directive.js";
import {formatTypeReferenceDirective} from "../../util/format-type-reference-directive.js";
import {pickResolvedModule} from "../../../../../util/pick-resolved-module.js";
import {trackImportsTransformer} from "../track-imports-transformer/track-imports-transformer.js";
import {trackExportsTransformer} from "../track-exports-transformer/track-exports-transformer.js";
import {statsCollector} from "../stats-collector/stats-collector.js";
import type {TypeReference} from "../../util/get-type-reference-module-from-file-name.js";
import {ensureNodeFactory} from "compatfactory";

function needsInitialize(options: DeclarationBundlerOptions): boolean {
	return options.sourceFileToExportedSymbolSet.size === 0 || options.sourceFileToImportedSymbolSet.size === 0 || options.moduleSpecifierToSourceFileMap.size === 0;
}

export function sourceFileBundler(options: DeclarationBundlerOptions, ...transformers: DeclarationTransformer[]): TS.TransformerFactory<TS.Bundle | TS.SourceFile> {
	return context => bundle => {
		const {typescript, host} = options;
		const factory = ensureNodeFactory(context.factory ?? typescript);

		// A Bundle of SourceFiles is expected. In case the SourceFileBundler is invoked with something other than that, do an early return
		if (typescript.isSourceFile(bundle)) {
			return bundle;
		}

		const updatedSourceFiles: TS.SourceFile[] = [];
		const entryModulesArr = [...options.chunk.entryModules];

		const sourceFileMap = new Map<string, TS.SourceFile>(bundle.sourceFiles.map(sourceFile => [sourceFile.fileName, sourceFile]));
		// Take file names for all SourceFiles
		const sourceFileNames = new Set(sourceFileMap.keys());
		const sourceFiles = [...sourceFileMap.values()];

		if (needsInitialize(options)) {
			sourceFiles.forEach(sourceFile => {
				for (const statement of sourceFile.statements) {
					if (typescript.isModuleDeclaration(statement)) {
						options.moduleSpecifierToSourceFileMap.set(statement.name.text, sourceFile);
					}
				}

				options.sourceFileToImportedSymbolSet.set(
					sourceFile.fileName,
					trackImportsTransformer({
						typescript: typescript,
						sourceFile
					})
				);

				options.sourceFileToExportedSymbolSet.set(
					sourceFile.fileName,
					trackExportsTransformer({
						typescript: typescript,
						factory,
						sourceFile
					})
				);
			});
		}

		// Only consider those SourceFiles that are part of the current chunk to be emitted
		const sourceFilesForChunk = sourceFiles.filter(sourceFile => getChunkFilename(sourceFile.fileName, options.chunks) === options.chunk.paths.absolute);

		// Visit only the entry SourceFile(s)
		const entrySourceFiles = sourceFilesForChunk
			.filter(sourceFile => options.chunk.entryModules.has(sourceFile.fileName))
			.sort((a, b) => (entryModulesArr.indexOf(a.fileName) < entryModulesArr.indexOf(b.fileName) ? -1 : 1));

		const nonEntrySourceFiles = sourceFilesForChunk.filter(sourceFile => !entrySourceFiles.includes(sourceFile));

		const firstEntrySourceFile = entrySourceFiles[0] as TS.SourceFile | undefined;
		const otherEntrySourceFilesForChunk = entrySourceFiles.filter(entrySourceFile => entrySourceFile !== firstEntrySourceFile);

		if (firstEntrySourceFile != null) {
			// Prepare some VisitorOptions
			const visitorOptions: SourceFileBundlerVisitorOptions = {
				...options,
				context,
				factory,
				extensions: host.getAllKnownTypescriptExtensions(),
				entrySourceFilesForChunk: entrySourceFiles,
				otherEntrySourceFilesForChunk,
				sourceFile: firstEntrySourceFile,
				lexicalEnvironment: {
					parent: undefined,
					bindings: new Map()
				},
				includedSourceFiles: new Set<string>([firstEntrySourceFile.fileName]),
				declarationToDeconflictedBindingMap: new Map<number, string>(),
				preservedImports: new Map(),
				inlinedModules: new Map(),

				resolveSourceFile: (fileName, from) => {
					for (const file of [fileName, `${fileName}/index`]) {
						if (options.moduleSpecifierToSourceFileMap.has(file)) {
							return options.moduleSpecifierToSourceFileMap.get(file)!;
						}
					}

					const resolved = options.host.resolve(fileName, from);

					if (resolved == null) return undefined;
					const pickedResolvedModule = pickResolvedModule(resolved, true);

					const resolvedSourceFile = pickedResolvedModule == null ? undefined : sourceFileMap.get(pickedResolvedModule);

					// Never allow resolving SourceFiles representing content not part of the compilation unit,
					// since that would lead to module merging assuming that modules will be part of the emitted declarations
					// even though they want, leading to undefined symbols
					if (resolvedSourceFile == null || !sourceFileNames.has(resolvedSourceFile.fileName)) return undefined;
					return resolvedSourceFile;
				}
			};

			// Run all transformers on the SourceFile
			let transformedSourceFile = applyTransformers({
				visitorOptions,
				transformers
			});

			// There may be additional transformers that are wrapped by this one. Run them on the transformed SourceFile rather than the entire bundle.
			if (options.wrappedTransformers != null && options.wrappedTransformers.afterDeclarations != null) {
				for (const transformerFactory of options.wrappedTransformers.afterDeclarations) {
					const transformer = transformerFactory(context);
					if ("transformSourceFile" in transformer) {
						transformedSourceFile = transformer.transformSourceFile(transformedSourceFile);
					} else {
						transformedSourceFile = transformer(transformedSourceFile) as TS.SourceFile;
					}
				}
			}

			// If a declarationStats hook has been provided to the plugin, collect stats and invoke the hook with the information
			if (options.declarationStats != null) {
				Object.assign(options.declarationStats, {
					[options.declarationPaths.fileName]: statsCollector({...visitorOptions, sourceFile: transformedSourceFile})
				});
			}

			updatedSourceFiles.push(transformedSourceFile);
		}

		for (const sourceFile of [...otherEntrySourceFilesForChunk, ...nonEntrySourceFiles]) {
			updatedSourceFiles.push(factory.updateSourceFile(sourceFile, [], true));
		}

		// Merge lib- and type reference directives.
		const libReferenceDirectiveFileNames = new Set<string>();
		const typeReferenceDirectiveFileNames = new Set<string>();
		const prepends: TS.UnparsedSource[] = [];
		const bundleWithSyntheticLibReferences = bundle as unknown as {syntheticLibReferences?: readonly TS.FileReference[]};

		if (bundleWithSyntheticLibReferences.syntheticLibReferences != null) {
			for (const {fileName} of bundleWithSyntheticLibReferences.syntheticLibReferences) {
				libReferenceDirectiveFileNames.add(fileName);
			}
		}

		for (const updatedSourceFile of updatedSourceFiles) {
			for (const {fileName} of updatedSourceFile.libReferenceDirectives) {
				libReferenceDirectiveFileNames.add(fileName);
			}

			for (const {fileName} of updatedSourceFile.typeReferenceDirectives) {
				typeReferenceDirectiveFileNames.add(fileName);
			}

			for (const typeReferenceModule of options.sourceFileToTypeReferencesSet.get(updatedSourceFile.fileName) ?? new Set<TypeReference>()) {
				typeReferenceDirectiveFileNames.add(typeReferenceModule.moduleSpecifier);
			}
		}

		libReferenceDirectiveFileNames.delete("");
		typeReferenceDirectiveFileNames.delete("");

		for (const fileName of libReferenceDirectiveFileNames) {
			prepends.push(typescript.createUnparsedSourceFile(formatLibReferenceDirective(fileName)));
		}

		for (const fileName of typeReferenceDirectiveFileNames) {
			prepends.push(typescript.createUnparsedSourceFile(formatTypeReferenceDirective(fileName)));
		}
		return factory.updateBundle(bundle, updatedSourceFiles, prepends);
	};
}
