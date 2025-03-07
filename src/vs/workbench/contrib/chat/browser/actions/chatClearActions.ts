/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { isChatViewTitleActionContext } from '../../common/chatActions.js';
import { ChatAgentLocation, IChatAgentService } from '../../common/chatAgents.js';
import { ChatContextKeys } from '../../common/chatContextKeys.js';
import { hasAppliedChatEditsContextKey, hasUndecidedChatEditingResourceContextKey, IChatEditingSession, WorkingSetEntryState } from '../../common/chatEditingService.js';
import { ChatViewId, EditsViewId, IChatWidget, IChatWidgetService } from '../chat.js';
import { EditingSessionAction } from '../chatEditing/chatEditingActions.js';
import { ctxIsGlobalEditingSession } from '../chatEditing/chatEditingEditorContextKeys.js';
import { ChatEditorInput } from '../chatEditorInput.js';
import { ChatViewPane } from '../chatViewPane.js';
import { CHAT_CATEGORY } from './chatActions.js';
import { clearChatEditor } from './chatClear.js';

export const ACTION_ID_NEW_CHAT = `workbench.action.chat.newChat`;
export const ACTION_ID_NEW_EDIT_SESSION = `workbench.action.chat.newEditSession`;
export const ChatDoneActionId = 'workbench.action.chat.done';

export interface INewEditSessionActionContext {
	/**
	 * An initial prompt to write to the chat.
	 */
	inputValue?: string;

	/**
	 * Selects opening in agent mode or not. If not set, the current mode is used.
	 * This is ignored when coming from a chat view title context.
	 */
	agentMode?: boolean;

	/**
	 * Whether the inputValue is partial and should wait for further user input. If false or not set, the prompt is sent immediately.
	 */
	isPartialQuery?: boolean;
}

export function registerNewChatActions() {
	registerAction2(class NewChatEditorAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chatEditor.newChat',
				title: localize2('chat.newChat.label', "New Chat"),
				icon: Codicon.plus,
				f1: false,
				precondition: ChatContextKeys.enabled,
				menu: [{
					id: MenuId.EditorTitle,
					group: 'navigation',
					order: 0,
					when: ActiveEditorContext.isEqualTo(ChatEditorInput.EditorID),
				}]
			});
		}
		async run(accessor: ServicesAccessor, ...args: any[]) {
			announceChatCleared(accessor.get(IAccessibilitySignalService));
			await clearChatEditor(accessor);
		}
	});

	registerAction2(class GlobalClearChatAction extends Action2 {
		constructor() {
			super({
				id: ACTION_ID_NEW_CHAT,
				title: localize2('chat.newChat.label', "New Chat"),
				category: CHAT_CATEGORY,
				icon: Codicon.plus,
				precondition: ContextKeyExpr.and(ChatContextKeys.enabled, ChatContextKeys.location.notEqualsTo(ChatAgentLocation.EditingSession)),
				f1: true,
				keybinding: {
					weight: KeybindingWeight.WorkbenchContrib,
					primary: KeyMod.CtrlCmd | KeyCode.KeyL,
					mac: {
						primary: KeyMod.WinCtrl | KeyCode.KeyL
					},
					when: ChatContextKeys.inChatSession
				},
				menu: [{
					id: MenuId.ChatContext,
					group: 'z_clear'
				},
				{
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', ChatViewId),
					group: 'navigation',
					order: -1
				}]
			});
		}

		async run(accessor: ServicesAccessor, ...args: any[]) {
			const context = args[0];
			const accessibilitySignalService = accessor.get(IAccessibilitySignalService);
			const widgetService = accessor.get(IChatWidgetService);

			let widget = widgetService.lastFocusedWidget;

			if (isChatViewTitleActionContext(context)) {
				// Is running in the Chat view title
				widget = widgetService.getWidgetBySessionId(context.sessionId);
			}

			if (widget) {
				announceChatCleared(accessibilitySignalService);
				widget.clear();
				widget.focusInput();
			}
		}
	});

	registerAction2(class NewEditSessionAction extends EditingSessionAction {
		constructor() {
			super({
				id: ACTION_ID_NEW_EDIT_SESSION,
				title: localize2('chat.newEdits.label', "New Edit Session"),
				category: CHAT_CATEGORY,
				icon: Codicon.plus,
				precondition: ContextKeyExpr.and(ChatContextKeys.enabled, ChatContextKeys.editingParticipantRegistered),
				f1: true,
				menu: [{
					id: MenuId.ChatContext,
					group: 'z_clear'
				},
				{
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', EditsViewId),
					group: 'navigation',
					order: -1
				}],
				keybinding: {
					weight: KeybindingWeight.WorkbenchContrib,
					primary: KeyMod.CtrlCmd | KeyCode.KeyL,
					mac: {
						primary: KeyMod.WinCtrl | KeyCode.KeyL
					},
					when: ContextKeyExpr.and(ChatContextKeys.inChatSession, ChatContextKeys.location.isEqualTo(ChatAgentLocation.EditingSession))
				}
			});
		}

		/**
		 *
		 * @returns false if the user had edits and did not action the dialog to take action on them, true otherwise
		 */
		private async _handleCurrentEditingSession(currentEditingSession: IChatEditingSession, dialogService: IDialogService): Promise<boolean> {
			const currentEdits = currentEditingSession?.entries.get();
			const currentEditCount = currentEdits?.length;

			if (currentEditingSession && currentEditCount) {
				const undecidedEdits = currentEdits.filter((edit) => edit.state.get() === WorkingSetEntryState.Modified);
				if (undecidedEdits.length) {
					const { result } = await dialogService.prompt({
						title: localize('chat.startEditing.confirmation.title', "Start new editing session?"),
						message: localize('chat.startEditing.confirmation.pending.message.2', "Starting a new editing session will end your current session. Do you want to accept pending edits to {0} files?", undecidedEdits.length),
						type: 'info',
						cancelButton: true,
						buttons: [
							{
								label: localize('chat.startEditing.confirmation.acceptEdits', "Accept & Continue"),
								run: async () => {
									await currentEditingSession.accept();
									return true;
								}
							},
							{
								label: localize('chat.startEditing.confirmation.discardEdits', "Discard & Continue"),
								run: async () => {
									await currentEditingSession.reject();
									return true;
								}
							}
						],
					});

					return Boolean(result);
				}
			}

			return true;
		}

		async runEditingSessionAction(accessor: ServicesAccessor, editingSession: IChatEditingSession, chatWidget: IChatWidget, ...args: any[]) {
			const context: INewEditSessionActionContext | undefined = args[0];
			const accessibilitySignalService = accessor.get(IAccessibilitySignalService);
			const widgetService = accessor.get(IChatWidgetService);
			const dialogService = accessor.get(IDialogService);
			const viewsService = accessor.get(IViewsService);
			const agentService = accessor.get(IChatAgentService);

			if (!(await this._handleCurrentEditingSession(editingSession, dialogService))) {
				return;
			}

			const isChatViewTitleAction = isChatViewTitleActionContext(context);

			let widget: IChatWidget | undefined;
			if (isChatViewTitleAction) {
				// Is running in the Chat view title
				widget = widgetService.getWidgetBySessionId(context.sessionId);
			} else {
				// Is running from f1 or keybinding
				const chatView = await viewsService.openView(EditsViewId) as ChatViewPane;
				widget = chatView.widget;
			}

			announceChatCleared(accessibilitySignalService);

			if (!widget) {
				return;
			}

			await editingSession.stop(true);
			widget.clear();
			widget.attachmentModel.clear();
			widget.input.relatedFiles?.clear();
			widget.focusInput();

			if (!context) {
				return;
			}

			if (!isChatViewTitleAction && typeof context.agentMode === 'boolean') {
				agentService.toggleToolsAgentMode(context.agentMode);
			}

			if (context.inputValue) {
				if (context.isPartialQuery) {
					widget.setInput(context.inputValue);
				} else {
					widget.acceptInput(context.inputValue);
				}
			}
		}
	});

	registerAction2(class GlobalEditsDoneAction extends Action2 {
		constructor() {
			super({
				id: ChatDoneActionId,
				title: localize2('chat.done.label', "Done"),
				category: CHAT_CATEGORY,
				precondition: ContextKeyExpr.and(ChatContextKeys.enabled, ChatContextKeys.editingParticipantRegistered),
				f1: false,
				menu: [{
					id: MenuId.ChatEditingWidgetToolbar,
					when: ContextKeyExpr.and(hasUndecidedChatEditingResourceContextKey.negate(), hasAppliedChatEditsContextKey, ChatContextKeys.editingParticipantRegistered, ChatContextKeys.location.isEqualTo(ChatAgentLocation.EditingSession)),
					group: 'navigation',
					order: 0
				}]
			});
		}

		async run(accessor: ServicesAccessor, ...args: any[]) {
			const context = args[0];
			const accessibilitySignalService = accessor.get(IAccessibilitySignalService);
			const widgetService = accessor.get(IChatWidgetService);
			if (isChatViewTitleActionContext(context)) {
				// Is running in the Chat view title
				announceChatCleared(accessibilitySignalService);
				const widget = widgetService.getWidgetBySessionId(context.sessionId);
				if (widget) {
					widget.clear();
					widget.attachmentModel.clear();
					widget.focusInput();
				}
			} else {
				// Is running from f1 or keybinding
				const viewsService = accessor.get(IViewsService);

				const chatView = await viewsService.openView(EditsViewId) as ChatViewPane;
				const widget = chatView.widget;

				announceChatCleared(accessibilitySignalService);
				widget.clear();
				widget.attachmentModel.clear();
				widget.focusInput();
			}
		}
	});

	registerAction2(class UndoChatEditInteractionAction extends EditingSessionAction {
		constructor() {
			super({
				id: 'workbench.action.chat.undoEdit',
				title: localize2('chat.undoEdit.label', "Undo Last Edit"),
				category: CHAT_CATEGORY,
				icon: Codicon.discard,
				precondition: ContextKeyExpr.and(ChatContextKeys.chatEditingCanUndo, ChatContextKeys.enabled, ChatContextKeys.editingParticipantRegistered),
				f1: true,
				menu: [{
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', EditsViewId),
					group: 'navigation',
					order: -3
				}]
			});
		}

		async runEditingSessionAction(accessor: ServicesAccessor, editingSession: IChatEditingSession) {
			await editingSession.undoInteraction();
		}
	});

	registerAction2(class RedoChatEditInteractionAction extends EditingSessionAction {
		constructor() {
			super({
				id: 'workbench.action.chat.redoEdit',
				title: localize2('chat.redoEdit.label', "Redo Last Edit"),
				category: CHAT_CATEGORY,
				icon: Codicon.redo,
				precondition: ContextKeyExpr.and(ChatContextKeys.chatEditingCanRedo, ChatContextKeys.enabled, ChatContextKeys.editingParticipantRegistered),
				f1: true,
				menu: [{
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.equals('view', EditsViewId),
					group: 'navigation',
					order: -2
				}]
			});
		}

		async runEditingSessionAction(accessor: ServicesAccessor, editingSession: IChatEditingSession) {
			await editingSession.redoInteraction();
		}
	});

	registerAction2(class GlobalOpenEditsAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.openEditSession',
				title: localize2('chat.openEdits.label', "Open {0}", 'Copilot Edits'),
				category: CHAT_CATEGORY,
				icon: Codicon.goToEditingSession,
				f1: true,
				menu: [{
					id: MenuId.ViewTitle,
					when: ContextKeyExpr.and(ContextKeyExpr.equals('view', ChatViewId), ChatContextKeys.editingParticipantRegistered,
						ContextKeyExpr.equals(`view.${EditsViewId}.visible`, false),
						ContextKeyExpr.or(
							ContextKeyExpr.and(ContextKeyExpr.equals(`workbench.panel.chat.defaultViewContainerLocation`, true), ContextKeyExpr.equals(`workbench.panel.chatEditing.defaultViewContainerLocation`, false)),
							ContextKeyExpr.and(ContextKeyExpr.equals(`workbench.panel.chat.defaultViewContainerLocation`, false), ContextKeyExpr.equals(`workbench.panel.chatEditing.defaultViewContainerLocation`, true)),
						)),
					group: 'navigation',
					order: 1
				}, {
					id: MenuId.ChatTitleBarMenu,
					group: 'a_open',
					order: 2
				}, {
					id: MenuId.ChatEditingEditorContent,
					when: ctxIsGlobalEditingSession,
					group: 'navigate',
					order: 4,
				}],
				keybinding: {
					weight: KeybindingWeight.WorkbenchContrib,
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
					linux: {
						primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyMod.Shift | KeyCode.KeyI
					},
					when: ContextKeyExpr.and(ContextKeyExpr.notEquals('view', EditsViewId), ChatContextKeys.editingParticipantRegistered)
				}
			});
		}

		async run(accessor: ServicesAccessor, ...args: any[]) {
			const viewsService = accessor.get(IViewsService);
			const chatView = await viewsService.openView(EditsViewId) as ChatViewPane;
			chatView.widget.focusInput();
		}
	});
}

function announceChatCleared(accessibilitySignalService: IAccessibilitySignalService): void {
	accessibilitySignalService.playSignal(AccessibilitySignal.clear);
}
