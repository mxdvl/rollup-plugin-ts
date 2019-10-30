import {ExportDeclaration, isStringLiteralLike} from "typescript";
import {TrackExportsVisitorOptions} from "../track-exports-visitor-options";

/**
 * Visits the given ExportDeclaration.
 * @param {TrackExportsVisitorOptions<ExportDeclaration>} options
 * @returns {ExportDeclaration | undefined}
 */
export function visitExportDeclaration({
	node,
	sourceFile,
	continuation,
	resolver,
	markAsExported
}: TrackExportsVisitorOptions<ExportDeclaration>): ExportDeclaration | undefined {
	// If there is an export clause, this is something like 'export {...} [from "..."]'.
	// We'll let other visitors handle such cases.
	if (node.exportClause != null) {
		continuation(node.exportClause);

		// Leave out the export
		return undefined;
	}

	// Otherwise, this is a 'export * from "..."' export that we need to handle here
	else {
		markAsExported({
			node,
			originalModule:
				node.moduleSpecifier == null || !isStringLiteralLike(node.moduleSpecifier)
					? sourceFile.fileName
					: resolver(node.moduleSpecifier.text, sourceFile.fileName),
			defaultExport: false,
			name: "*",
			propertyName: undefined
		});
		return undefined;
	}
}
