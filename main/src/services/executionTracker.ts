import { EventEmitter } from 'events';
import type { Logger } from '../utils/logger';
import type { SessionManager } from './sessionManager';
import { GitDiffManager, type GitDiffResult } from './gitDiffManager';
import type { CreateExecutionDiffData } from '../database/models';
import { execSync } from '../utils/commandExecutor';
import { buildGitCommitCommand } from '../utils/shellEscape';
import { formatForDisplay } from '../utils/timestampUtils';
import { commitManager } from './commitManager';
import type { CommitModeSettings } from '../../../shared/types';

interface ExecutionContext {
  sessionId: string;
  worktreePath: string;
  promptMarkerId?: number;
  beforeCommitHash: string;
  executionSequence: number;
  prompt?: string;
}

export class ExecutionTracker extends EventEmitter {
  private activeExecutions: Map<string, ExecutionContext> = new Map();

  constructor(
    private sessionManager: any,
    private gitDiffManager: GitDiffManager,
    private logger?: Logger
  ) {
    super();
  }

  /**
   * Start tracking a new prompt execution
   */
  async startExecution(sessionId: string, worktreePath: string, promptMarkerId?: number, prompt?: string): Promise<void> {
    try {
      this.logger?.verbose(`Starting execution tracking for session ${sessionId}`);
      
      // Get next execution sequence
      const executionSequence = await this.sessionManager.getNextExecutionSequence(sessionId);
      
      // Capture the current commit hash as the starting point
      const beforeCommitHash = this.gitDiffManager.getCurrentCommitHash(worktreePath);
      this.logger?.verbose(`Starting from commit: ${beforeCommitHash}`);
      
      const context: ExecutionContext = {
        sessionId,
        worktreePath,
        promptMarkerId,
        beforeCommitHash,
        executionSequence,
        prompt
      };
      
      this.activeExecutions.set(sessionId, context);
      this.emit('execution-started', { sessionId, executionSequence });
      
    } catch (error) {
      this.logger?.error(`Failed to start execution tracking for session ${sessionId}:`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * End execution tracking and capture final diff
   */
  async endExecution(sessionId: string): Promise<void> {
    try {
      const context = this.activeExecutions.get(sessionId);
      if (!context) {
        this.logger?.warn(`No active execution found for session ${sessionId}`);
        return;
      }

      this.logger?.verbose(`Ending execution tracking for session ${sessionId}`);
      
      // Get session details for commit mode
      const session = this.sessionManager.getSession(sessionId);
      this.logger?.verbose(`Retrieved session for ${sessionId}: ${session ? 'found' : 'not found'}`);
      
      // Determine commit mode - default to checkpoint for backwards compatibility
      let commitMode: 'structured' | 'checkpoint' | 'disabled' = 'checkpoint';
      let commitModeSettings: CommitModeSettings = {
        mode: 'checkpoint',
        checkpointPrefix: 'checkpoint: '
      };
      
      if (session?.commitMode) {
        commitMode = session.commitMode;
        this.logger?.verbose(`Using session.commitMode: ${commitMode}`);
        
        // Update the commitModeSettings.mode to match the actual mode
        commitModeSettings.mode = commitMode;
        
        if (session.commitModeSettings) {
          try {
            const parsedSettings = JSON.parse(session.commitModeSettings);
            commitModeSettings = { ...commitModeSettings, ...parsedSettings, mode: commitMode };
            this.logger?.verbose(`Parsed commit mode settings: ${JSON.stringify(commitModeSettings)}`);
          } catch (e) {
            this.logger?.error(`Failed to parse commit mode settings: ${e}`);
          }
        }
      } else if (session?.autoCommit !== undefined) {
        // Backwards compatibility: convert autoCommit boolean to commit mode
        commitMode = session.autoCommit ? 'checkpoint' : 'disabled';
        commitModeSettings.mode = commitMode;
        this.logger?.verbose(`Using legacy autoCommit (${session.autoCommit}) -> commit mode: ${commitMode}`);
      }
      
      this.logger?.verbose(`Final commit mode for session ${sessionId}: ${commitMode}`);
      
      // Handle post-prompt commit based on mode
      const commitResult = await commitManager.handlePostPromptCommit(
        sessionId,
        context.worktreePath,
        commitModeSettings,
        context.prompt,
        context.executionSequence
      );
      
      if (!commitResult.success && commitResult.error) {
        // Add error to session output so users can see what went wrong
        const commitErrorMessage = {
          type: 'system',
          subtype: 'autocommit_error',
          timestamp: new Date().toISOString(),
          mode: commitMode,
          error: commitResult.error,
          message: 'Failed to create commit during Claude Code execution. Changes remain uncommitted. You may need to fix the issues and commit manually.'
        };
        
        console.log(`[ExecutionTracker] Adding autocommit error message for session ${sessionId}:`, commitErrorMessage);
        
        this.sessionManager.addSessionOutput(sessionId, {
          type: 'json',
          data: commitErrorMessage,
          timestamp: new Date()
        });
      } else if (commitResult.success && commitMode !== 'disabled') {
        // Add success message to session output for successful commits
        if (commitMode === 'checkpoint') {
          const commitSuccessMessage = {
            type: 'system',
            subtype: 'autocommit_success',
            timestamp: new Date().toISOString(),
            mode: 'checkpoint',
            commit_hash: commitResult.commitHash,
            message: 'Checkpoint commit created successfully. Changes have been automatically committed during execution.'
          };
          
          console.log(`[ExecutionTracker] Adding autocommit success message for session ${sessionId}:`, commitSuccessMessage);
          
          this.sessionManager.addSessionOutput(sessionId, {
            type: 'json',
            data: commitSuccessMessage,
            timestamp: new Date()
          });
        } else if (commitMode === 'structured') {
          const structuredModeMessage = {
            type: 'system',
            subtype: 'autocommit_mode',
            timestamp: new Date().toISOString(),
            mode: 'structured',
            message: 'Structured mode active. Claude will handle commits when appropriate.'
          };
          
          this.sessionManager.addSessionOutput(sessionId, {
            type: 'json',
            data: structuredModeMessage,
            timestamp: new Date()
          });
        }
      }
      
      // For structured mode, we may need to wait for Claude to create the commit
      if (commitMode === 'structured') {
        this.logger?.verbose(`Waiting for structured commit from Claude...`);
        const structuredCommitResult = await commitManager.waitForStructuredCommit(
          sessionId,
          context.worktreePath,
          5000 // 5 second timeout for now, can be adjusted
        );
        
        if (!structuredCommitResult.success) {
          this.logger?.warn(`Structured commit not detected: ${structuredCommitResult.error}`);
          const timeoutMessage = {
            type: 'system',
            subtype: 'autocommit_timeout',
            timestamp: new Date().toISOString(),
            mode: 'structured',
            error: structuredCommitResult.error || 'Timeout waiting for commit',
            message: 'Claude did not create a commit within the expected timeframe. Claude may have chosen not to commit, or may need more time.'
          };
          
          this.sessionManager.addSessionOutput(sessionId, {
            type: 'json',
            data: timeoutMessage,
            timestamp: new Date()
          });
        } else if (structuredCommitResult.commitHash) {
          const claudeCommitMessage = {
            type: 'system',
            subtype: 'autocommit_claude_success',
            timestamp: new Date().toISOString(),
            mode: 'structured',
            commit_hash: structuredCommitResult.commitHash,
            message: 'Claude successfully created a commit according to your structured mode settings.'
          };
          
          this.sessionManager.addSessionOutput(sessionId, {
            type: 'json',
            data: claudeCommitMessage,
            timestamp: new Date()
          });
        }
      }
      
      // Get the current commit hash after auto-commit
      const afterCommitHash = this.gitDiffManager.getCurrentCommitHash(context.worktreePath);
      
      let executionDiff: GitDiffResult;
      
      // Always get the diff between the before and after commits
      if (afterCommitHash === context.beforeCommitHash) {
        // No changes at all
        executionDiff = await this.gitDiffManager.captureWorkingDirectoryDiff(context.worktreePath);
        this.logger?.verbose(`No changes made during execution`);
      } else {
        // Get the diff between commits
        executionDiff = await this.gitDiffManager.captureCommitDiff(
          context.worktreePath, 
          context.beforeCommitHash, 
          afterCommitHash
        );
        this.logger?.verbose(`Captured diff between commits ${context.beforeCommitHash} and ${afterCommitHash}`);
      }
      
      // Always create execution diff record, even if there are no changes
      const diffData: CreateExecutionDiffData = {
        session_id: sessionId,
        prompt_marker_id: context.promptMarkerId,
        execution_sequence: context.executionSequence,
        git_diff: executionDiff.diff,
        files_changed: executionDiff.changedFiles,
        stats_additions: executionDiff.stats.additions,
        stats_deletions: executionDiff.stats.deletions,
        stats_files_changed: executionDiff.stats.filesChanged,
        before_commit_hash: executionDiff.beforeHash,
        after_commit_hash: executionDiff.afterHash
      };

      const createdDiff = await this.sessionManager.createExecutionDiff(diffData);
      
      if (executionDiff.stats.filesChanged > 0) {
        this.logger?.verbose(`Created execution diff ${createdDiff.id}: ${createdDiff.stats_files_changed} files, +${createdDiff.stats_additions} -${createdDiff.stats_deletions}`);
      } else {
        this.logger?.verbose(`Created execution diff ${createdDiff.id} with no changes for execution ${context.executionSequence} in session ${sessionId}`);
      }
      
      this.emit('execution-completed', { 
        sessionId, 
        executionSequence: context.executionSequence,
        diffId: createdDiff.id,
        stats: executionDiff.stats
      });
      
      this.activeExecutions.delete(sessionId);
      
    } catch (error) {
      this.logger?.error(`Failed to end execution tracking for session ${sessionId}:`, error instanceof Error ? error : undefined);
      this.activeExecutions.delete(sessionId);
      throw error;
    }
  }

  /**
   * Cancel execution tracking (e.g., if Claude Code process fails)
   */
  cancelExecution(sessionId: string): void {
    const context = this.activeExecutions.get(sessionId);
    if (context) {
      this.logger?.verbose(`Cancelling execution tracking for session ${sessionId}`);
      this.activeExecutions.delete(sessionId);
      this.emit('execution-cancelled', { sessionId, executionSequence: context.executionSequence });
    }
  }

  /**
   * Check if execution is being tracked for a session
   */
  isTracking(sessionId: string): boolean {
    return this.activeExecutions.has(sessionId);
  }

  /**
   * Get execution context for a session
   */
  getExecutionContext(sessionId: string): ExecutionContext | undefined {
    return this.activeExecutions.get(sessionId);
  }

  /**
   * Get combined diff for multiple executions
   */
  async getCombinedDiff(sessionId: string, executionIds?: number[]): Promise<GitDiffResult> {
    const executions = await this.sessionManager.getExecutionDiffs(sessionId);
    
    // Commented out verbose logging
    // console.log(`[ExecutionTracker] getCombinedDiff for session ${sessionId}, found ${executions.length} executions`);
    
    let filteredExecutions = executions;
    if (executionIds && executionIds.length > 0) {
      filteredExecutions = executions.filter((exec: any) => executionIds.includes(exec.id));
      // console.log(`[ExecutionTracker] Filtered to ${filteredExecutions.length} executions`);
    }
    
    const diffs: GitDiffResult[] = filteredExecutions
      .filter((exec: any) => exec.git_diff) // Only include executions with actual diffs
      .map((exec: any) => ({
        diff: exec.git_diff!,
        stats: {
          additions: exec.stats_additions,
          deletions: exec.stats_deletions,
          filesChanged: exec.stats_files_changed
        },
        changedFiles: exec.files_changed || [],
        beforeHash: exec.before_commit_hash,
        afterHash: exec.after_commit_hash
      }));
    
    // console.log(`[ExecutionTracker] Found ${diffs.length} diffs to combine`);
    
    return this.gitDiffManager.combineDiffs(diffs);
  }

  async getExecutionDiffs(sessionId: string): Promise<any[]> {
    const diffs = await this.sessionManager.getExecutionDiffs(sessionId);
    // Commented out verbose logging
    // console.log(`[ExecutionTracker] getExecutionDiffs returned ${diffs.length} diffs for session ${sessionId}`);
    // if (diffs.length > 0) {
    //   console.log(`[ExecutionTracker] First diff:`, {
    //     id: diffs[0].id,
    //     hasGitDiff: !!diffs[0].git_diff,
    //     gitDiffLength: diffs[0].git_diff?.length || 0,
    //     stats: {
    //       additions: diffs[0].stats_additions,
    //       deletions: diffs[0].stats_deletions,
    //       filesChanged: diffs[0].stats_files_changed
    //     }
    //   });
    // }
    return diffs;
  }
}