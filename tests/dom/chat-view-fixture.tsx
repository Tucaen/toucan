import {
  ChatView,
  type ChatComposerProps,
  type ChatPendingProps,
  type ChatSearchProps,
  type ChatSessionControlsProps,
  type ChatTranscriptProps
} from '../../src/renderer/src/ChatNode'

export type TestChatViewProps = ChatTranscriptProps &
  ChatComposerProps &
  ChatPendingProps &
  Omit<ChatSessionControlsProps, 'status' | 'detail'> & {
    setDraft(value: string): void
    sendMessage(text: string): void
    search?: ChatSearchProps
  }

/** Keeps behavior-oriented tests concise while production callers use the cohesive contracts. */
export function TestChatView(props: TestChatViewProps): JSX.Element {
  const { focusMode, setFocusMode, focusShortcutEnabled, empty, statusBar, completedTaskIds, closedDecisionIds } = props
  return (
    <ChatView
      transcript={{
        provider: props.provider,
        messages: props.messages,
        activities: props.activities,
        outcomes: props.outcomes,
        transcript: props.transcript,
        plan: props.plan,
        workspaceRoots: props.workspaceRoots,
        commands: props.commands
      }}
      composer={{
        draft: props.draft,
        imageSupport: props.imageSupport,
        attachments: props.attachments,
        queued: props.queued,
        addImages: props.addImages,
        removeAttachment: props.removeAttachment,
        submit: props.submit,
        editQueued: props.editQueued,
        withdrawQueued: props.withdrawQueued,
        sendQueuedNow: props.sendQueuedNow,
        cancel: props.cancel,
        onDraftChange: props.onDraftChange,
        fileMentions: props.fileMentions,
        modes: props.modes,
        models: props.models,
        efforts: props.efforts,
        selectorsDisabled: props.selectorsDisabled,
        selectMode: props.selectMode,
        selectModel: props.selectModel,
        selectEffort: props.selectEffort
      }}
      pending={{
        approval: props.approval,
        decisionRequest: props.decisionRequest,
        resolveApproval: props.resolveApproval,
        resolveElicitation: props.resolveElicitation,
        authMethods: props.authMethods,
        authLink: props.authLink,
        reauthenticating: props.reauthenticating,
        authenticate: props.authenticate,
        submitAuthCode: props.submitAuthCode,
        openAuthLink: props.openAuthLink,
        answerDecision: props.answerDecision
      }}
      session={{
        status: props.status,
        detail: props.detail,
        focusMode,
        setFocusMode,
        focusShortcutEnabled,
        empty,
        statusBar,
        completedTaskIds,
        closedDecisionIds
      }}
      search={props.search}
    />
  )
}
