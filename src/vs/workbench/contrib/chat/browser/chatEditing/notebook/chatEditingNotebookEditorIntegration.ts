/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, IObservable, ISettableObservable, observableFromEvent, observableValue } from '../../../../../../base/common/observable.js';
import { debouncedObservable } from '../../../../../../base/common/observableInternal/utils.js';
import { basename } from '../../../../../../base/common/resources.js';
import { assertType } from '../../../../../../base/common/types.js';
import { LineRange } from '../../../../../../editor/common/core/lineRange.js';
import { Range } from '../../../../../../editor/common/core/range.js';
import { nullDocumentDiff } from '../../../../../../editor/common/diff/documentDiffProvider.js';
import { localize } from '../../../../../../nls.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { MenuId } from '../../../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IEditorPane, IResourceDiffEditorInput } from '../../../../../common/editor.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { NotebookDeletedCellDecorator } from '../../../../notebook/browser/diff/inlineDiff/notebookDeletedCellDecorator.js';
import { NotebookInsertedCellDecorator } from '../../../../notebook/browser/diff/inlineDiff/notebookInsertedCellDecorator.js';
import { NotebookModifiedCellDecorator } from '../../../../notebook/browser/diff/inlineDiff/notebookModifiedCellDecorator.js';
import { INotebookTextDiffEditor } from '../../../../notebook/browser/diff/notebookDiffEditorBrowser.js';
import { getNotebookEditorFromEditorPane, ICellViewModel, INotebookEditor } from '../../../../notebook/browser/notebookBrowser.js';
import { INotebookEditorService } from '../../../../notebook/browser/services/notebookEditorService.js';
import { NotebookCellTextModel } from '../../../../notebook/common/model/notebookCellTextModel.js';
import { NotebookTextModel } from '../../../../notebook/common/model/notebookTextModel.js';
import { CellKind } from '../../../../notebook/common/notebookCommon.js';
import { IChatAgentService } from '../../../common/chatAgents.js';
import { IModifiedFileEntryChangeHunk, IModifiedFileEntryEditorIntegration } from '../../../common/chatEditingService.js';
import { ChatAgentLocation } from '../../../common/constants.js';
import { ChatEditingCodeEditorIntegration, IDocumentDiff2 } from '../chatEditingCodeEditorIntegration.js';
import { ChatEditingModifiedNotebookEntry } from '../chatEditingModifiedNotebookEntry.js';
import { countChanges, ICellDiffInfo, sortCellChanges } from './notebookCellChanges.js';

export class ChatEditingNotebookEditorIntegration extends Disposable implements IModifiedFileEntryEditorIntegration {
	private integration: ChatEditingNotebookEditorWidgetIntegration;
	private notebookEditor: INotebookEditor;
	constructor(
		_entry: ChatEditingModifiedNotebookEntry,
		editor: IEditorPane,
		notebookModel: NotebookTextModel,
		originalModel: NotebookTextModel,
		cellChanges: IObservable<ICellDiffInfo[]>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		const notebookEditor = getNotebookEditorFromEditorPane(editor);
		assertType(notebookEditor);
		this.notebookEditor = notebookEditor;
		this.integration = this.instantiationService.createInstance(ChatEditingNotebookEditorWidgetIntegration, _entry, notebookEditor, notebookModel, originalModel, cellChanges);
		this._register(editor.onDidChangeControl(() => {
			const notebookEditor = getNotebookEditorFromEditorPane(editor);
			if (notebookEditor && notebookEditor !== this.notebookEditor) {
				this.notebookEditor = notebookEditor;
				this.integration.dispose();
				this.integration = this.instantiationService.createInstance(ChatEditingNotebookEditorWidgetIntegration, _entry, notebookEditor, notebookModel, originalModel, cellChanges);
			}
		}));
	}
	public get currentIndex(): IObservable<number> {
		return this.integration.currentIndex;
	}
	reveal(firstOrLast: boolean): void {
		return this.integration.reveal(firstOrLast);
	}
	next(wrap: boolean): boolean {
		return this.integration.next(wrap);
	}
	previous(wrap: boolean): boolean {
		return this.integration.previous(wrap);
	}
	enableAccessibleDiffView(): void {
		this.integration.enableAccessibleDiffView();
	}
	acceptNearestChange(change: IModifiedFileEntryChangeHunk): void {
		this.integration.acceptNearestChange(change);
	}
	rejectNearestChange(change: IModifiedFileEntryChangeHunk): void {
		this.integration.rejectNearestChange(change);
	}
	toggleDiff(change: IModifiedFileEntryChangeHunk | undefined): Promise<void> {
		return this.integration.toggleDiff(change);
	}

	public override dispose(): void {
		this.integration.dispose();
		super.dispose();
	}
}

class ChatEditingNotebookEditorWidgetIntegration extends Disposable implements IModifiedFileEntryEditorIntegration {
	private readonly _currentIndex = observableValue(this, -1);
	readonly currentIndex: IObservable<number> = this._currentIndex;

	private readonly _currentChange = observableValue<{ change: ICellDiffInfo; index: number } | undefined>(this, undefined);
	readonly currentChange: IObservable<{ change: ICellDiffInfo; index: number } | undefined> = this._currentChange;

	private deletedCellDecorator: NotebookDeletedCellDecorator | undefined;
	private insertedCellDecorator: NotebookInsertedCellDecorator | undefined;
	private modifiedCellDecorator: NotebookModifiedCellDecorator | undefined;

	private readonly cellEditorIntegrations = new Map<NotebookCellTextModel, { integration: ChatEditingCodeEditorIntegration; diff: ISettableObservable<IDocumentDiff2> }>();

	private readonly mdCellEditorAttached = observableValue<number>(this, -1);

	private markupCellListeners = new Map<number, IDisposable>();

	constructor(
		private readonly _entry: ChatEditingModifiedNotebookEntry,
		private readonly notebookEditor: INotebookEditor,
		private readonly notebookModel: NotebookTextModel,
		originalModel: NotebookTextModel,
		private readonly cellChanges: IObservable<ICellDiffInfo[]>,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly _editorService: IEditorService,
		@IChatAgentService private readonly _chatAgentService: IChatAgentService,
		@INotebookEditorService notebookEditorService: INotebookEditorService,
		@IAccessibilitySignalService private readonly accessibilitySignalService: IAccessibilitySignalService,
	) {
		super();

		const onDidChangeVisibleRanges = debouncedObservable(observableFromEvent(notebookEditor.onDidChangeVisibleRanges, () => notebookEditor.visibleRanges), 50);

		this._register(toDisposable(() => {
			this.markupCellListeners.forEach((v) => v.dispose());
		}));

		let originalReadonly: boolean | undefined = undefined;
		const shouldBeReadonly = _entry.isCurrentlyBeingModifiedBy.map(value => !!value);
		this._register(autorun(r => {
			const isReadOnly = shouldBeReadonly.read(r);
			const notebookEditor = notebookEditorService.retrieveExistingWidgetFromURI(_entry.modifiedURI)?.value;
			if (!notebookEditor) {
				return;
			}
			originalReadonly ??= notebookEditor.isReadOnly;
			if (isReadOnly) {
				notebookEditor.setOptions({ isReadOnly: true });
			} else if (originalReadonly === false) {
				notebookEditor.setOptions({ isReadOnly: false });
				// Ensure all cells area editable.
				// We make use of chatEditingCodeEditorIntegration to handle cell diffing and navigation.
				// However that also makes the cell read-only. We need to ensure that the cell is editable.
				// E.g. first we make notebook readonly (in here), then cells end up being readonly because notebook is readonly.
				// Then chatEditingCodeEditorIntegration makes cells readonly and keeps track of the original readonly state.
				// However the cell is already readonly because the notebook is readonly.
				// So when we restore the notebook to editable (in here), the cell is made editable again.
				// But when chatEditingCodeEditorIntegration attempts to restore, it will restore the original readonly state.
				// & from the perpspective of chatEditingCodeEditorIntegration, the cell was readonly & should continue to be readonly.
				// To get around this, we wait for a few ms before restoring the original readonly state for each cell.
				const timeout = setTimeout(() => {
					notebookEditor.setOptions({ isReadOnly: true });
					notebookEditor.setOptions({ isReadOnly: false });
					disposable.dispose();
				}, 100);
				const disposable = toDisposable(() => clearTimeout(timeout));
				this._register(disposable);
			}
		}));

		// INIT when not streaming nor diffing the response anymore, once per request, and when having changes
		let lastModifyingRequestId: string | undefined;
		this._store.add(autorun(r => {

			if (!_entry.isCurrentlyBeingModifiedBy.read(r)
				&& !_entry.isProcessingResponse.read(r)
				&& lastModifyingRequestId !== _entry.lastModifyingRequestId
				&& cellChanges.read(r).some(c => c.type !== 'unchanged' && !c.diff.read(r).identical)
			) {
				lastModifyingRequestId = _entry.lastModifyingRequestId;
				this.reveal(true);
			}
		}));

		// Build cell integrations (responsible for navigating changes within a cell and decorating cell text changes)
		this._register(autorun(r => {
			if (this.notebookEditor.textModel !== this.notebookModel) {
				return;
			}
			const sortedCellChanges = sortCellChanges(cellChanges.read(r));

			const changes = sortedCellChanges.filter(c => c.type !== 'delete');
			onDidChangeVisibleRanges.read(r);
			if (!changes.length) {
				this.cellEditorIntegrations.forEach(({ diff }) => {
					diff.set({ ...diff.get(), ...nullDocumentDiff }, undefined);
				});
				return;
			}
			this.mdCellEditorAttached.read(r);

			const validCells = new Set<NotebookCellTextModel>();
			changes.forEach((change) => {
				if (change.modifiedCellIndex === undefined || change.modifiedCellIndex >= notebookModel.cells.length) {
					return;
				}
				const cell = notebookModel.cells[change.modifiedCellIndex];
				const editor = notebookEditor.codeEditors.find(([vm,]) => vm.handle === notebookModel.cells[change.modifiedCellIndex].handle)?.[1];
				const modifiedModel = change.modifiedModel.promiseResult.read(r)?.data;
				const originalModel = change.originalModel.promiseResult.read(r)?.data;
				if (!cell || !originalModel || !modifiedModel) {
					return;
				}
				if (!editor) {
					if (!this.markupCellListeners.has(cell.handle) && cell.cellKind === CellKind.Markup) {
						const cellModel = this.notebookEditor.getViewModel()?.viewCells.find(c => c.handle === cell.handle);
						if (cellModel) {
							const listener = cellModel.onDidChangeEditorAttachState(() => {
								if (cellModel.editorAttached) {
									this.mdCellEditorAttached.set(cell.handle, undefined);
									listener.dispose();
									this.markupCellListeners.delete(cell.handle);
								}
							});
							this.markupCellListeners.set(cell.handle, listener);
						}
					}
					return;
				}
				const diff = {
					...change.diff.read(r),
					modifiedModel,
					originalModel,
					keep: change.keep,
					undo: change.undo
				} satisfies IDocumentDiff2;
				validCells.add(cell);
				const currentDiff = this.cellEditorIntegrations.get(cell);
				if (currentDiff) {
					// Do not unnecessarily trigger a change event
					if (!areDocumentDiff2Equal(currentDiff.diff.get(), diff)) {
						currentDiff.diff.set(diff, undefined);
					}
				} else {
					const diff2 = observableValue(`diff${cell.handle}`, diff);
					const integration = this.instantiationService.createInstance(ChatEditingCodeEditorIntegration, _entry, editor, diff2);
					this.cellEditorIntegrations.set(cell, { integration, diff: diff2 });
					this._register(integration);
					this._register(editor.onDidDispose(() => {
						this.cellEditorIntegrations.get(cell)?.integration.dispose();
						this.cellEditorIntegrations.delete(cell);
					}));
					this._register(editor.onDidChangeModel(() => {
						if (editor.getModel() !== cell.textModel) {
							this.cellEditorIntegrations.get(cell)?.integration.dispose();
							this.cellEditorIntegrations.delete(cell);
						}
					}));
				}
			});

			// Dispose old integrations as the editors are no longer valid.
			this.cellEditorIntegrations.forEach((v, cell) => {
				if (!validCells.has(cell)) {
					v.integration.dispose();
					this.cellEditorIntegrations.delete(cell);
				}
			});
		}));

		this._register(autorun(r => {
			const currentChange = this.currentChange.read(r);
			if (!currentChange) {
				this._currentIndex.set(-1, undefined);
				return;
			}

			let index = 0;
			const sortedCellChanges = sortCellChanges(cellChanges.read(r));
			for (const change of sortedCellChanges) {
				if (currentChange && currentChange.change === change) {
					if (change.type === 'modified') {
						index += currentChange.index;
					}
					break;
				}
				if (change.type === 'insert' || change.type === 'delete') {
					index++;
				} else if (change.type === 'modified') {
					index += change.diff.read(r).changes.length;
				}
			}

			this._currentIndex.set(index, undefined);
		}));

		const cellsAreVisible = onDidChangeVisibleRanges.map(v => v.length > 0);
		const debouncedChanges = debouncedObservable(cellChanges, 10);
		this._register(autorun(r => {
			if (this.notebookEditor.textModel !== this.notebookModel || !cellsAreVisible.read(r) || !this.notebookEditor.getViewModel()) {
				return;
			}
			// We can have inserted cells that have been accepted, in those cases we do not want any decorators on them.
			const changes = debouncedChanges.read(r).filter(c => c.type === 'insert' ? !c.diff.read(r).identical : true);
			const modifiedChanges = changes.filter(c => c.type === 'modified');

			this.createDecorators();
			this.insertedCellDecorator?.apply(changes);
			this.modifiedCellDecorator?.apply(modifiedChanges);
			this.deletedCellDecorator?.apply(changes, originalModel);
		}));
	}

	private createDecorators() {
		const cellChanges = this.cellChanges.get();
		const accessibilitySignalService = this.accessibilitySignalService;

		this.insertedCellDecorator ??= this._register(this.instantiationService.createInstance(NotebookInsertedCellDecorator, this.notebookEditor));
		this.modifiedCellDecorator ??= this._register(this.instantiationService.createInstance(NotebookModifiedCellDecorator, this.notebookEditor));

		if (this.deletedCellDecorator) {
			this._store.delete(this.deletedCellDecorator);
			this.deletedCellDecorator.dispose();
		}
		this.deletedCellDecorator = this._register(this.instantiationService.createInstance(NotebookDeletedCellDecorator, this.notebookEditor, {
			className: 'chat-diff-change-content-widget',
			telemetrySource: 'chatEditingNotebookHunk',
			menuId: MenuId.ChatEditingEditorHunk,
			argFactory: (deletedCellIndex: number) => {
				return {
					accept() {
						const entry = cellChanges.find(c => c.type === 'delete' && c.originalCellIndex === deletedCellIndex);
						if (entry) {
							return entry.keep(entry.diff.get().changes[0]);
						}
						accessibilitySignalService.playSignal(AccessibilitySignal.editsKept, { allowManyInParallel: true });
						return Promise.resolve(true);
					},
					reject() {
						const entry = cellChanges.find(c => c.type === 'delete' && c.originalCellIndex === deletedCellIndex);
						if (entry) {
							return entry.undo(entry.diff.get().changes[0]);
						}
						accessibilitySignalService.playSignal(AccessibilitySignal.editsUndone, { allowManyInParallel: true });
						return Promise.resolve(true);
					},
				} satisfies IModifiedFileEntryChangeHunk;
			}
		}));
	}

	getCell(modifiedCellIndex: number) {
		const cell = this.notebookModel.cells[modifiedCellIndex];
		const integration = this.cellEditorIntegrations.get(cell)?.integration;
		return integration;
	}

	reveal(firstOrLast: boolean): void {
		const changes = sortCellChanges(this.cellChanges.get().filter(c => c.type !== 'unchanged'));
		if (!changes.length) {
			return undefined;
		}
		const change = firstOrLast ? changes[0] : changes[changes.length - 1];
		this._revealFirstOrLast(change, firstOrLast);
	}

	private _revealFirstOrLast(change: ICellDiffInfo, firstOrLast: boolean = true) {
		switch (change.type) {
			case 'insert':
			case 'modified':
				{
					const index = firstOrLast || change.type === 'insert' ? 0 : change.diff.get().changes.length - 1;
					const cellIntegration = this.getCell(change.modifiedCellIndex);
					if (cellIntegration) {
						cellIntegration.reveal(firstOrLast);
						this._currentChange.set({ change: change, index }, undefined);
						return true;
					} else {
						return this._revealChange(change, index);
					}
				}
			case 'delete':
				// reveal the deleted cell decorator
				this.deletedCellDecorator?.reveal(change.originalCellIndex);
				this._currentChange.set({ change: change, index: 0 }, undefined);
				return true;
			default:
				break;
		}

		return false;
	}

	private _revealChange(change: ICellDiffInfo, indexInCell: number) {
		switch (change.type) {
			case 'insert':
			case 'modified':
				{
					const textChange = change.diff.get().changes[indexInCell];
					const cellViewModel = this.getCellViewModel(change);
					if (cellViewModel) {
						this.revealChangeInView(cellViewModel, textChange?.modified);
						this._currentChange.set({ change: change, index: indexInCell }, undefined);
					}

					return true;
				}
			case 'delete':
				// reveal the deleted cell decorator
				this.deletedCellDecorator?.reveal(change.originalCellIndex);
				this._currentChange.set({ change: change, index: 0 }, undefined);
				return true;
			default:
				break;
		}

		return false;
	}

	private getCellViewModel(change: ICellDiffInfo) {
		if (change.type === 'delete' || change.modifiedCellIndex === undefined) {
			return undefined;
		}
		const cell = this.notebookModel.cells[change.modifiedCellIndex];
		const cellViewModel = this.notebookEditor.getViewModel()?.viewCells.find(c => c.handle === cell.handle);
		return cellViewModel;
	}

	private async revealChangeInView(cell: ICellViewModel, lines: LineRange | undefined): Promise<void> {
		const targetLines = lines ?? new LineRange(0, 0);
		await this.notebookEditor.focusNotebookCell(cell, 'container', { focusEditorLine: targetLines.startLineNumber });
		await this.notebookEditor.revealRangeInCenterAsync(cell, new Range(targetLines.startLineNumber, 0, targetLines.endLineNumberExclusive, 0));
	}

	next(wrap: boolean): boolean {
		const changes = sortCellChanges(this.cellChanges.get().filter(c => c.type !== 'unchanged'));
		const currentChange = this.currentChange.get();
		if (!currentChange) {
			const firstChange = changes[0];

			if (firstChange) {
				return this._revealFirstOrLast(firstChange);
			}

			return false;
		}

		// go to next
		// first check if we are at the end of the current change
		switch (currentChange.change.type) {
			case 'modified':
				{
					const cellIntegration = this.getCell(currentChange.change.modifiedCellIndex);
					if (cellIntegration) {
						if (cellIntegration.next(false)) {
							this._currentChange.set({ change: currentChange.change, index: cellIntegration.currentIndex.get() }, undefined);
							return true;
						}
					}

					const isLastChangeInCell = currentChange.index === lastChangeIndex(currentChange.change);
					const index = isLastChangeInCell ? 0 : currentChange.index + 1;
					const change = isLastChangeInCell ? changes[changes.indexOf(currentChange.change) + 1] : currentChange.change;

					if (change) {
						return this._revealChange(change, index);
					}
				}
				break;
			case 'insert':
			case 'delete':
				{
					// go to next change directly
					const nextChange = changes[changes.indexOf(currentChange.change) + 1];
					if (nextChange) {
						return this._revealFirstOrLast(nextChange, true);
					}
				}
				break;
			default:
				break;
		}

		if (wrap) {
			return this.next(false);
		}

		return false;
	}

	previous(wrap: boolean): boolean {
		const changes = sortCellChanges(this.cellChanges.get().filter(c => c.type !== 'unchanged'));
		const currentChange = this.currentChange.get();
		if (!currentChange) {
			const lastChange = changes[changes.length - 1];
			if (lastChange) {
				return this._revealFirstOrLast(lastChange, false);
			}

			return false;
		}

		// go to previous
		// first check if we are at the start of the current change
		switch (currentChange.change.type) {
			case 'modified':
				{
					const cellIntegration = this.getCell(currentChange.change.modifiedCellIndex);
					if (cellIntegration) {
						if (cellIntegration.previous(false)) {
							this._currentChange.set({ change: currentChange.change, index: cellIntegration.currentIndex.get() }, undefined);
							return true;
						}
					}

					const isFirstChangeInCell = currentChange.index === 0;
					const change = isFirstChangeInCell ? changes[changes.indexOf(currentChange.change) - 1] : currentChange.change;

					if (change) {
						const index = isFirstChangeInCell ? lastChangeIndex(change) : currentChange.index - 1;
						return this._revealChange(change, index);
					}
				}
				break;
			case 'insert':
			case 'delete':
				{
					// go to previous change directly
					const prevChange = changes[changes.indexOf(currentChange.change) - 1];
					if (prevChange) {
						return this._revealFirstOrLast(prevChange, false);
					}
				}
				break;
			default:
				break;
		}

		if (wrap) {
			const lastChange = changes[changes.length - 1];
			if (lastChange) {
				return this._revealFirstOrLast(lastChange, false);
			}
		}

		return false;
	}

	enableAccessibleDiffView(): void {
		const cell = this.notebookEditor.getActiveCell()?.model;
		if (cell) {
			const integration = this.cellEditorIntegrations.get(cell)?.integration;
			integration?.enableAccessibleDiffView();
		}
	}
	acceptNearestChange(change: IModifiedFileEntryChangeHunk): void {
		change.accept();
		this.next(true);
	}
	rejectNearestChange(change: IModifiedFileEntryChangeHunk): void {
		change.reject();
		this.next(true);
	}
	async toggleDiff(_change: IModifiedFileEntryChangeHunk | undefined): Promise<void> {
		const defaultAgentName = this._chatAgentService.getDefaultAgent(ChatAgentLocation.EditingSession)?.fullName;
		const diffInput = {
			original: { resource: this._entry.originalURI, options: { selection: undefined } },
			modified: { resource: this._entry.modifiedURI, options: { selection: undefined } },
			label: defaultAgentName
				? localize('diff.agent', '{0} (changes from {1})', basename(this._entry.modifiedURI), defaultAgentName)
				: localize('diff.generic', '{0} (changes from chat)', basename(this._entry.modifiedURI))
		} satisfies IResourceDiffEditorInput;
		await this._editorService.openEditor(diffInput);

	}
}

export class ChatEditingNotebookDiffEditorIntegration extends Disposable implements IModifiedFileEntryEditorIntegration {
	private readonly _currentIndex = observableValue(this, -1);
	readonly currentIndex: IObservable<number> = this._currentIndex;

	constructor(
		private readonly notebookDiffEditor: INotebookTextDiffEditor,
		private readonly cellChanges: IObservable<ICellDiffInfo[]>
	) {
		super();

		this._store.add(autorun(r => {
			const index = notebookDiffEditor.currentChangedIndex.read(r);
			const numberOfCellChanges = cellChanges.read(r).filter(c => !c.diff.read(r).identical);
			if (numberOfCellChanges.length && index >= 0 && index < numberOfCellChanges.length) {
				// Notebook Diff editor only supports navigating through changes to cells.
				// However in chat we take changes to lines in the cells into account.
				// So if we're on the second cell and first cell has 3 changes, then we're on the 4th change.
				const changesSoFar = countChanges(numberOfCellChanges.slice(0, index + 1));
				this._currentIndex.set(changesSoFar - 1, undefined);
			} else {
				this._currentIndex.set(-1, undefined);
			}
		}));
	}

	reveal(firstOrLast: boolean): void {
		const changes = sortCellChanges(this.cellChanges.get().filter(c => c.type !== 'unchanged'));
		if (!changes.length) {
			return undefined;
		}
		if (firstOrLast) {
			this.notebookDiffEditor.firstChange();
		} else {
			this.notebookDiffEditor.lastChange();
		}
	}

	next(_wrap: boolean): boolean {
		const changes = this.cellChanges.get().filter(c => !c.diff.get().identical).length;
		if (this.notebookDiffEditor.currentChangedIndex.get() === changes - 1) {
			return false;
		}
		this.notebookDiffEditor.nextChange();
		return true;
	}

	previous(_wrap: boolean): boolean {
		const changes = this.cellChanges.get().filter(c => !c.diff.get().identical).length;
		if (this.notebookDiffEditor.currentChangedIndex.get() === changes - 1) {
			return false;
		}
		this.notebookDiffEditor.nextChange();
		return true;
	}

	enableAccessibleDiffView(): void {
		//
	}
	acceptNearestChange(change: IModifiedFileEntryChangeHunk): void {
		change.accept();
		this.next(true);
	}
	rejectNearestChange(change: IModifiedFileEntryChangeHunk): void {
		change.reject();
		this.next(true);
	}
	async toggleDiff(_change: IModifiedFileEntryChangeHunk | undefined): Promise<void> {
		//
	}
}

function areDocumentDiff2Equal(diff1: IDocumentDiff2, diff2: IDocumentDiff2): boolean {
	if (diff1.changes !== diff2.changes) {
		return false;
	}
	if (diff1.identical !== diff2.identical) {
		return false;
	}
	if (diff1.moves !== diff2.moves) {
		return false;
	}
	if (diff1.originalModel !== diff2.originalModel) {
		return false;
	}
	if (diff1.modifiedModel !== diff2.modifiedModel) {
		return false;
	}
	if (diff1.keep !== diff2.keep) {
		return false;
	}
	if (diff1.undo !== diff2.undo) {
		return false;
	}
	if (diff1.quitEarly !== diff2.quitEarly) {
		return false;
	}
	return true;
}

function lastChangeIndex(change: ICellDiffInfo): number {
	if (change.type === 'modified') {
		return change.diff.get().changes.length - 1;
	}
	return 0;
}
