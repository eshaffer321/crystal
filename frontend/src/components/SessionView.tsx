import { useRef, useEffect, useState, memo, useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { JsonMessageView } from './JsonMessageView';
import { EmptyState } from './EmptyState';
import CombinedDiffView from './CombinedDiffView';
import { StravuFileSearch } from './StravuFileSearch';
import { Inbox } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { useSessionView } from '../hooks/useSessionView';
import { SessionHeader } from './session/SessionHeader';
import { SessionInputWithImages } from './session/SessionInputWithImages';
import { GitErrorDialog } from './session/GitErrorDialog';
import { CommitMessageDialog } from './session/CommitMessageDialog';
import { PromptNavigation } from './PromptNavigation';
import { isDocumentVisible } from '../utils/performanceUtils';
import { FileEditor } from './FileEditor';
import { ProjectView } from './ProjectView';
import { API } from '../utils/api';
import { Button } from './ui/Button';
import { Card, CardContent } from './ui/Card';
import { RichOutputWithSidebar } from './session/RichOutputWithSidebar';

export const SessionView = memo(() => {
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const sessions = useSessionStore((state) => state.sessions);
  const activeMainRepoSession = useSessionStore((state) => state.activeMainRepoSession);
  const { activeView, activeProjectId } = useNavigationStore();
  const [animationsEnabled, setAnimationsEnabled] = useState(isDocumentVisible());
  const [projectData, setProjectData] = useState<any>(null);
  const [isProjectLoading, setIsProjectLoading] = useState(false);
  const [isMergingProject, setIsMergingProject] = useState(false);
  const [sessionProject, setSessionProject] = useState<any>(null);

  // Define activeSession early so it can be used in effects
  const activeSession = activeSessionId 
    ? (activeMainRepoSession && activeMainRepoSession.id === activeSessionId 
        ? activeMainRepoSession 
        : sessions.find(s => s.id === activeSessionId))
    : undefined;

  useEffect(() => {
    const handleVisibilityChange = () => {
      setAnimationsEnabled(isDocumentVisible());
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Load project data for active session
  useEffect(() => {
    const loadSessionProject = async () => {
      if (activeSession?.projectId) {
        try {
          const response = await API.projects.getAll();
          if (response.success && response.data) {
            const project = response.data.find((p: any) => p.id === activeSession.projectId);
            if (project) {
              setSessionProject(project);
            }
          }
        } catch (error) {
          console.error('Failed to load session project:', error);
        }
      } else {
        setSessionProject(null);
      }
    };
    loadSessionProject();
  }, [activeSession?.projectId]);

  // Load project data when activeProjectId changes
  useEffect(() => {
    if (activeView === 'project' && activeProjectId) {
      const loadProjectData = async () => {
        setIsProjectLoading(true);
        try {
          // Get all projects and find the one we need
          const response = await API.projects.getAll();
          if (response.success && response.data) {
            const project = response.data.find((p: any) => p.id === activeProjectId);
            if (project) {
              setProjectData(project);
            }
          }
        } catch (error) {
          console.error('Failed to load project data:', error);
        } finally {
          setIsProjectLoading(false);
        }
      };
      loadProjectData();
    } else {
      setProjectData(null);
    }
  }, [activeView, activeProjectId]);

  const handleProjectGitPull = async () => {
    if (!activeProjectId || !projectData) return;
    setIsMergingProject(true);
    try {
      // Get or create main repo session for this project
      const sessionResponse = await API.sessions.getOrCreateMainRepoSession(activeProjectId);
      if (sessionResponse.success && sessionResponse.data) {
        const response = await API.sessions.gitPull(sessionResponse.data.id);
        if (!response.success) {
          console.error('Git pull failed:', response.error);
        }
      }
    } catch (error) {
      console.error('Failed to perform git pull:', error);
    } finally {
      setIsMergingProject(false);
    }
  };

  const handleProjectGitPush = async () => {
    if (!activeProjectId || !projectData) return;
    setIsMergingProject(true);
    try {
      // Get or create main repo session for this project
      const sessionResponse = await API.sessions.getOrCreateMainRepoSession(activeProjectId);
      if (sessionResponse.success && sessionResponse.data) {
        const response = await API.sessions.gitPush(sessionResponse.data.id);
        if (!response.success) {
          console.error('Git push failed:', response.error);
        }
      }
    } catch (error) {
      console.error('Failed to perform git push:', error);
    } finally {
      setIsMergingProject(false);
    }
  };

  const terminalRef = useRef<HTMLDivElement>(null);
  const scriptTerminalRef = useRef<HTMLDivElement>(null);

  const hook = useSessionView(activeSession, terminalRef, scriptTerminalRef);
  
  // Memoize props to prevent unnecessary re-renders
  const emptySelectedExecutions = useMemo(() => [], []);
  const isMainRepo = useMemo(() => activeSession?.isMainRepo || false, [activeSession?.isMainRepo]);

  // Show project view if navigation is set to project
  if (activeView === 'project' && activeProjectId) {
    if (isProjectLoading || !projectData) {
      return (
        <div className="flex-1 flex flex-col overflow-hidden bg-surface-secondary p-6">
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-interactive mx-auto mb-4"></div>
              <p className="text-text-secondary">Loading project...</p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <ProjectView
        projectId={activeProjectId}
        projectName={projectData.name || 'Project'}
        onGitPull={handleProjectGitPull}
        onGitPush={handleProjectGitPush}
        isMerging={isMergingProject}
      />
    );
  }

  if (!activeSession) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-bg-primary">
        <EmptyState
          icon={Inbox}
          title="No Session Selected"
          description="Select a session from the sidebar to view its output, or create a new session to get started."
          className="flex-1"
        />
      </div>
    );
  }
  
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg-primary">
      <SessionHeader
        activeSession={activeSession}
        isEditingName={hook.isEditingName}
        editName={hook.editName}
        setEditName={hook.setEditName}
        handleNameKeyDown={hook.handleNameKeyDown}
        handleSaveEditName={hook.handleSaveEditName}
        handleStartEditName={hook.handleStartEditName}
        isMerging={hook.isMerging}
        handleGitPull={hook.handleGitPull}
        handleGitPush={hook.handleGitPush}
        handleRebaseMainIntoWorktree={hook.handleRebaseMainIntoWorktree}
        hasChangesToRebase={hook.hasChangesToRebase}
        gitCommands={hook.gitCommands}
        handleSquashAndRebaseToMain={hook.handleSquashAndRebaseToMain}
        handleOpenIDE={hook.handleOpenIDE}
        isOpeningIDE={hook.isOpeningIDE}
        hasIdeCommand={!!sessionProject?.open_ide_command}
        mergeError={hook.mergeError}
        viewMode={hook.viewMode}
        setViewMode={hook.setViewMode}
        unreadActivity={hook.unreadActivity}
        setUnreadActivity={hook.setUnreadActivity}
      />
      
      <div className="flex-1 flex relative min-h-0">
        <div className="flex-1 relative">
          {hook.isLoadingOutput && (
            <div className="absolute top-4 left-4 text-text-secondary z-10">Loading output...</div>
          )}
          <div className={`bg-bg-primary h-full ${hook.viewMode === 'output' ? 'flex flex-col' : 'hidden'} relative`}>
            <div 
              ref={terminalRef} 
              className="flex-1 min-h-0"
            />
            {(activeSession.status === 'running' || activeSession.status === 'initializing') && (
              <div className="bg-surface-primary border-t border-border-primary px-4 py-2 flex-shrink-0">
                <div className="flex items-center justify-between text-text-primary">
                    <div className="flex items-center space-x-3">
                        <div className="flex space-x-1">
                            <div className={`w-2 h-2 bg-interactive rounded-full ${animationsEnabled ? 'animate-typing-dot' : ''}`}></div>
                            <div className={`w-2 h-2 bg-interactive rounded-full ${animationsEnabled ? 'animate-typing-dot' : ''}`} style={{ animationDelay: '0.2s' }}></div>
                            <div className={`w-2 h-2 bg-interactive rounded-full ${animationsEnabled ? 'animate-typing-dot' : ''}`} style={{ animationDelay: '0.4s' }}></div>
                        </div>
                        <span className="text-sm font-medium">
                            {activeSession.status === 'initializing' ? 'Starting Claude Code...' : 'Claude is working...'}
                        </span>
                    </div>
                    <div className="flex items-center space-x-3">
                        <div className="text-xs text-text-secondary font-mono">
                            {activeSession.status === 'initializing' ? '⚡' : hook.formatElapsedTime(hook.elapsedTime)}
                        </div>
                        <button onClick={hook.handleStopSession} className="px-3 py-1 text-xs bg-status-error hover:bg-status-error/90 text-white rounded-md transition-colors">
                            Cancel
                        </button>
                    </div>
                </div>
              </div>
            )}
            {hook.loadError && hook.viewMode === 'output' && (
              <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-center">
                <Card variant="bordered" className="shadow-lg">
                  <CardContent className="p-6">
                    <p className="text-text-primary mb-2">Failed to load output content</p>
                    <p className="text-text-secondary text-sm mb-4">{hook.loadError}</p>
                    <Button onClick={() => hook.loadOutputContent(activeSession.id)}>
                      Reload Output
                    </Button>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
          <div className={`h-full ${hook.viewMode === 'messages' ? 'block' : 'hidden'}`}>
            <JsonMessageView messages={activeSession.jsonMessages || []} />
          </div>
          <div className={`h-full ${hook.viewMode === 'richOutput' ? 'block' : 'hidden'}`}>
            <RichOutputWithSidebar 
              sessionId={activeSession.id} 
            />
          </div>
          <div className={`h-full ${hook.viewMode === 'changes' ? 'block' : 'hidden'} overflow-hidden`}>
            <CombinedDiffView 
              sessionId={activeSession.id} 
              selectedExecutions={emptySelectedExecutions} 
              isGitOperationRunning={hook.isMerging}
              isMainRepo={isMainRepo}
              isVisible={hook.viewMode === 'changes'}
            />
          </div>
          <div className={`h-full ${hook.viewMode === 'terminal' ? 'flex flex-col' : 'hidden'} bg-bg-primary`}>
            <div className="flex items-center justify-between px-4 py-2 bg-surface-secondary border-b border-border-primary">
              <div className="text-sm text-text-secondary">
                Terminal
              </div>
              {!activeSession.archived && (
                <button
                  onClick={hook.handleClearTerminal}
                  className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
                  title="Clear terminal"
                >
                  <svg 
                    className="w-4 h-4" 
                    fill="none" 
                    stroke="currentColor" 
                    viewBox="0 0 24 24"
                  >
                    <path 
                      strokeLinecap="round" 
                      strokeLinejoin="round" 
                      strokeWidth={2} 
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" 
                    />
                  </svg>
                </button>
              )}
            </div>
            {activeSession.archived ? (
              <div className="flex-1 flex items-center justify-center p-8">
                <div className="text-center max-w-md">
                  <div className="mb-4">
                    <svg className="w-16 h-16 mx-auto text-text-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-medium text-text-primary mb-2">
                    No Terminal History Available
                  </h3>
                  <p className="text-sm text-text-secondary">
                    This session has been archived. Terminal history is not preserved for archived sessions to save resources.
                  </p>
                  <p className="text-sm text-text-secondary mt-2">
                    The session outputs and conversation history are still available in the Output and Messages views.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div ref={scriptTerminalRef} className="flex-1" />
                <div className="h-2" />
              </>
            )}
          </div>
          <div className={`h-full ${hook.viewMode === 'editor' ? 'block' : 'hidden'}`}>
            <FileEditor sessionId={activeSession.id} />
          </div>
        </div>
        {hook.viewMode === 'output' && (
          <PromptNavigation 
            sessionId={activeSession.id} 
            onNavigateToPrompt={hook.handleNavigateToPrompt}
          />
        )}
      </div>
      
      {hook.viewMode !== 'terminal' && (
        <SessionInputWithImages
          activeSession={activeSession}
          viewMode={hook.viewMode}
          input={hook.input}
          setInput={hook.setInput}
          textareaRef={hook.textareaRef}
          handleTerminalCommand={hook.handleTerminalCommand}
          handleSendInput={hook.handleSendInput}
          handleContinueConversation={hook.handleContinueConversation}
          isStravuConnected={hook.isStravuConnected}
          setShowStravuSearch={hook.setShowStravuSearch}
          ultrathink={hook.ultrathink}
          setUltrathink={hook.setUltrathink}
          gitCommands={hook.gitCommands}
          handleCompactContext={hook.handleCompactContext}
          contextCompacted={hook.contextCompacted}
          hasConversationHistory={hook.hasConversationHistory}
        />
      )}

      <CommitMessageDialog
        isOpen={hook.showCommitMessageDialog}
        onClose={() => hook.setShowCommitMessageDialog(false)}
        dialogType={hook.dialogType}
        gitCommands={hook.gitCommands}
        commitMessage={hook.commitMessage}
        setCommitMessage={hook.setCommitMessage}
        shouldSquash={hook.shouldSquash}
        setShouldSquash={hook.setShouldSquash}
        onConfirm={hook.performSquashWithCommitMessage}
        isMerging={hook.isMerging}
      />

      <GitErrorDialog
        isOpen={hook.showGitErrorDialog}
        onClose={() => hook.setShowGitErrorDialog(false)}
        errorDetails={hook.gitErrorDetails}
        getGitErrorTips={hook.getGitErrorTips}
        onAbortAndUseClaude={hook.handleAbortRebaseAndUseClaude}
      />

      <StravuFileSearch
        isOpen={hook.showStravuSearch}
        onClose={() => hook.setShowStravuSearch(false)}
        onFileSelect={hook.handleStravuFileSelect}
      />
    </div>
  );
});

SessionView.displayName = 'SessionView';