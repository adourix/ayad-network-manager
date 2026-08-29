export interface SystemCommandResult {
  stdout: string;
  stderr: string;
}

export interface SystemCommandExecutor {
  execute(
    command: string,
    args: string[],
  ): Promise<SystemCommandResult>;
}

