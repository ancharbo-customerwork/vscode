/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { autorun } from '../../../../../base/common/observable.js';
import { basename, isEqual } from '../../../../../base/common/resources.js';
import { assertDefined } from '../../../../../base/common/types.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICodeEditor, isCodeEditor, isDiffEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { Location } from '../../../../../editor/common/languages.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { EditorsOrder } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { getNotebookEditorFromEditorPane, INotebookEditor } from '../../../notebook/browser/notebookBrowser.js';
import { IChatEditingService } from '../../common/chatEditingService.js';
import { IChatRequestFileEntry, IChatRequestImplicitVariableEntry } from '../../common/chatModel.js';
import { IChatService } from '../../common/chatService.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { ILanguageModelIgnoredFilesService } from '../../common/ignoredFiles.js';
import { PROMPT_LANGUAGE_ID } from '../../common/promptSyntax/constants.js';
import { IChatWidget, IChatWidgetService } from '../chat.js';
import { createPromptVariableId } from '../chatAttachmentModel/chatPromptAttachmentsCollection.js';

export class ChatImplicitContextContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'chat.implicitContext';

	private readonly _currentCancelTokenSource = this._register(new MutableDisposable<CancellationTokenSource>());

	private _implicitContextEnablement = this.configurationService.getValue<{ [mode: string]: string }>('chat.implicitContext.enabled');

	constructor(
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IEditorService private readonly editorService: IEditorService,
		@IChatWidgetService private readonly chatWidgetService: IChatWidgetService,
		@IChatService private readonly chatService: IChatService,
		@IChatEditingService private readonly chatEditingService: IChatEditingService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILanguageModelIgnoredFilesService private readonly ignoredFilesService: ILanguageModelIgnoredFilesService,
	) {
		super();

		const activeEditorDisposables = this._register(new DisposableStore());

		this._register(Event.runAndSubscribe(
			editorService.onDidActiveEditorChange,
			(() => {
				activeEditorDisposables.clear();
				const codeEditor = this.findActiveCodeEditor();
				if (codeEditor) {
					activeEditorDisposables.add(Event.debounce(
						Event.any(
							codeEditor.onDidChangeModel,
							codeEditor.onDidChangeCursorSelection,
							codeEditor.onDidScrollChange,
							codeEditor.onDidChangeModelLanguage),
						() => undefined,
						500)(() => this.updateImplicitContext()));
				}

				const notebookEditor = this.findActiveNotebookEditor();
				if (notebookEditor) {
					const activeCellDisposables = activeEditorDisposables.add(new DisposableStore());
					activeEditorDisposables.add(notebookEditor.onDidChangeActiveCell(() => {
						activeCellDisposables.clear();
						const codeEditor = this.codeEditorService.getActiveCodeEditor();
						if (codeEditor && codeEditor.getModel()?.uri.scheme === Schemas.vscodeNotebookCell) {
							activeCellDisposables.add(Event.debounce(
								Event.any(
									codeEditor.onDidChangeModel,
									codeEditor.onDidChangeCursorSelection,
									codeEditor.onDidScrollChange),
								() => undefined,
								500)(() => this.updateImplicitContext()));
						}
					}));

					activeEditorDisposables.add(Event.debounce(
						Event.any(
							notebookEditor.onDidChangeModel,
							notebookEditor.onDidChangeActiveCell
						),
						() => undefined,
						500)(() => this.updateImplicitContext()));
				}

				this.updateImplicitContext();
			})));
		this._register(autorun((reader) => {
			this.chatEditingService.editingSessionsObs.read(reader);
			this.updateImplicitContext();
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('chat.implicitContext.enabled')) {
				this._implicitContextEnablement = this.configurationService.getValue<{ [mode: string]: string }>('chat.implicitContext.enabled');
				this.updateImplicitContext();
			}
		}));
		this._register(this.chatService.onDidSubmitRequest(({ chatSessionId }) => {
			const widget = this.chatWidgetService.getWidgetBySessionId(chatSessionId);
			if (!widget?.input.implicitContext) {
				return;
			}
			if (this._implicitContextEnablement[widget.location] === 'first' && widget.viewModel?.getItems().length !== 0) {
				widget.input.implicitContext.setValue(undefined, false, undefined);
			}
		}));
		this._register(this.chatWidgetService.onDidAddWidget(async (widget) => {
			await this.updateImplicitContext(widget);
		}));
	}

	private findActiveCodeEditor(): ICodeEditor | undefined {
		const codeEditor = this.codeEditorService.getActiveCodeEditor();
		if (codeEditor) {
			const model = codeEditor.getModel();
			if (model?.uri.scheme === Schemas.vscodeNotebookCell) {
				return undefined;
			}

			if (model) {
				return codeEditor;
			}
		}
		for (const codeOrDiffEditor of this.editorService.getVisibleTextEditorControls(EditorsOrder.MOST_RECENTLY_ACTIVE)) {
			let codeEditor: ICodeEditor;
			if (isDiffEditor(codeOrDiffEditor)) {
				codeEditor = codeOrDiffEditor.getModifiedEditor();
			} else if (isCodeEditor(codeOrDiffEditor)) {
				codeEditor = codeOrDiffEditor;
			} else {
				continue;
			}

			const model = codeEditor.getModel();
			if (model) {
				return codeEditor;
			}
		}
		return undefined;
	}

	private findActiveNotebookEditor(): INotebookEditor | undefined {
		return getNotebookEditorFromEditorPane(this.editorService.activeEditorPane);
	}

	private async updateImplicitContext(updateWidget?: IChatWidget): Promise<void> {
		const cancelTokenSource = this._currentCancelTokenSource.value = new CancellationTokenSource();
		const codeEditor = this.findActiveCodeEditor();
		const model = codeEditor?.getModel();
		const selection = codeEditor?.getSelection();
		let newValue: Location | URI | undefined;
		let isSelection = false;

		let languageId: string | undefined;
		if (model) {
			languageId = model.getLanguageId();
			if (selection && !selection.isEmpty()) {
				newValue = { uri: model.uri, range: selection } satisfies Location;
				isSelection = true;
			} else {
				const visibleRanges = codeEditor?.getVisibleRanges();
				if (visibleRanges && visibleRanges.length > 0) {
					// Merge visible ranges. Maybe the reference value could actually be an array of Locations?
					// Something like a Location with an array of Ranges?
					let range = visibleRanges[0];
					visibleRanges.slice(1).forEach(r => {
						range = range.plusRange(r);
					});
					newValue = { uri: model.uri, range } satisfies Location;
				} else {
					newValue = model.uri;
				}
			}
		}

		const notebookEditor = this.findActiveNotebookEditor();
		if (notebookEditor) {
			const activeCell = notebookEditor.getActiveCell();
			if (activeCell) {
				const codeEditor = this.codeEditorService.getActiveCodeEditor();
				const selection = codeEditor?.getSelection();
				const visibleRanges = codeEditor?.getVisibleRanges() || [];
				newValue = activeCell.uri;
				if (isEqual(codeEditor?.getModel()?.uri, activeCell.uri)) {
					if (selection && !selection.isEmpty()) {
						newValue = { uri: activeCell.uri, range: selection } satisfies Location;
						isSelection = true;
					} else if (visibleRanges.length > 0) {
						// Merge visible ranges. Maybe the reference value could actually be an array of Locations?
						// Something like a Location with an array of Ranges?
						let range = visibleRanges[0];
						visibleRanges.slice(1).forEach(r => {
							range = range.plusRange(r);
						});
						newValue = { uri: activeCell.uri, range } satisfies Location;
					}
				}
			} else {
				newValue = notebookEditor.textModel?.uri;
			}
		}

		const uri = newValue instanceof URI ? newValue : newValue?.uri;
		if (uri && await this.ignoredFilesService.fileIsIgnored(uri, cancelTokenSource.token)) {
			newValue = undefined;
		}

		if (cancelTokenSource.token.isCancellationRequested) {
			return;
		}

		const widgets = updateWidget ? [updateWidget] : [...this.chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Panel), ...this.chatWidgetService.getWidgetsByLocations(ChatAgentLocation.Editor)];
		for (const widget of widgets) {
			if (!widget.input.implicitContext) {
				continue;
			}
			const setting = this._implicitContextEnablement[widget.location];
			const isFirstInteraction = widget.viewModel?.getItems().length === 0;
			if (setting === 'first' && !isFirstInteraction) {
				widget.input.implicitContext.setValue(undefined, false, languageId);
			} else if (setting === 'always' || setting === 'first' && isFirstInteraction) {
				widget.input.implicitContext.setValue(newValue, isSelection, languageId);
			} else if (setting === 'never') {
				widget.input.implicitContext.setValue(undefined, false, languageId);
			}
		}
	}
}

export class ChatImplicitContext extends Disposable implements IChatRequestImplicitVariableEntry {
	get id() {
		// IDs for prompt files need to start with a special prefix
		// that is used by the copilot extension to identify them
		if (this.isPrompt) {
			assertDefined(
				this.value,
				'Implicit prompt attachments must have a value.',
			);

			if (URI.isUri(this.value)) {
				return createPromptVariableId(this.value, true);
			}

			return createPromptVariableId(this.value.uri, true);
		}

		if (URI.isUri(this.value)) {
			return 'vscode.implicit.file';
		} else if (this.value) {
			if (this._isSelection) {
				return 'vscode.implicit.selection';
			} else {
				return 'vscode.implicit.viewport';
			}
		} else {
			return 'vscode.implicit';
		}
	}

	get name(): string {
		const fileType = this.isPrompt ? 'prompt' : 'file';

		if (URI.isUri(this.value)) {
			return `${fileType}:${basename(this.value)}`;
		} else if (this.value) {
			return `${fileType}:${basename(this.value.uri)}`;
		} else {
			return 'implicit';
		}
	}

	readonly kind = 'implicit';

	get modelDescription(): string {
		if (this.isPrompt) {
			if (URI.isUri(this.value)) {
				return `User's active prompt instructions file that user expects you to follow`;
			} else if (this._isSelection) {
				return `User's active selection inside prompt instructions that user expects you to follow`;
			} else {
				return `User's current visible prompt instructions text that user expects you to follow`;
			}
		}

		if (URI.isUri(this.value)) {
			return `User's active file`;
		} else if (this._isSelection) {
			return `User's active selection`;
		} else {
			return `User's current visible code`;
		}
	}

	readonly isFile = true;

	private _isSelection = false;
	public get isSelection(): boolean {
		return this._isSelection;
	}

	private _onDidChangeValue = new Emitter<void>();
	readonly onDidChangeValue = this._onDidChangeValue.event;

	private _value: Location | URI | undefined;
	get value() {
		return this._value;
	}

	private _languageId: string | undefined;
	get languageId() {
		return this._languageId;
	}

	get isPrompt() {
		return (this.languageId === PROMPT_LANGUAGE_ID);
	}

	private _enabled = true;
	get enabled() {
		return this._enabled;
	}

	set enabled(value: boolean) {
		this._enabled = value;
		this._onDidChangeValue.fire();
	}

	constructor(value?: Location | URI) {
		super();
		this._value = value;
	}

	setValue(value: Location | URI | undefined, isSelection: boolean, languageId?: string): void {
		this._value = value;
		this._isSelection = isSelection;
		this._languageId = languageId;
		this._onDidChangeValue.fire();
	}

	toBaseEntry(): IChatRequestFileEntry {
		return {
			kind: 'file',
			id: this.id,
			name: this.name,
			value: this.value,
			modelDescription: this.modelDescription
		};
	}
}
