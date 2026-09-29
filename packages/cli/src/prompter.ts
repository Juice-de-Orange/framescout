/**
 * Thin abstraction over `@inquirer/prompts` so the interactive flow in
 * `commands/init.ts` is testable. Production builds use the
 * {@link defaultPrompter} below; unit tests inject an in-memory fake
 * that returns pre-baked answers and asserts the question order.
 */
export interface SelectChoice<T> {
  readonly name: string;
  readonly value: T;
  readonly description?: string;
}

export interface CheckboxChoice<T> {
  readonly name: string;
  readonly value: T;
  readonly checked?: boolean;
  readonly description?: string;
}

export interface Prompter {
  input(opts: {
    readonly message: string;
    readonly default?: string;
    readonly validate?: (v: string) => true | string;
  }): Promise<string>;
  password(opts: {
    readonly message: string;
    readonly mask?: string;
    readonly validate?: (v: string) => true | string;
  }): Promise<string>;
  confirm(opts: {
    readonly message: string;
    readonly default?: boolean;
  }): Promise<boolean>;
  select<T>(opts: {
    readonly message: string;
    readonly choices: ReadonlyArray<SelectChoice<T>>;
    readonly default?: T;
  }): Promise<T>;
  checkbox<T>(opts: {
    readonly message: string;
    readonly choices: ReadonlyArray<CheckboxChoice<T>>;
  }): Promise<readonly T[]>;
}

/**
 * Wraps `@inquirer/prompts`. Lazy-imported so unit tests that only
 * exercise the in-memory fake never load the real terminal-UI library.
 */
export const defaultPrompter: Prompter = {
  async input(opts) {
    const { input } = await import('@inquirer/prompts');
    return input(opts);
  },
  async password(opts) {
    const { password } = await import('@inquirer/prompts');
    return password({ mask: opts.mask ?? '*', ...opts });
  },
  async confirm(opts) {
    const { confirm } = await import('@inquirer/prompts');
    return confirm(opts);
  },
  async select(opts) {
    const { select } = await import('@inquirer/prompts');
    return select({
      message: opts.message,
      choices: opts.choices.map((c) => ({
        name: c.name,
        value: c.value,
        ...(c.description !== undefined && { description: c.description }),
      })),
      ...(opts.default !== undefined && { default: opts.default }),
    });
  },
  async checkbox(opts) {
    const { checkbox } = await import('@inquirer/prompts');
    return checkbox({
      message: opts.message,
      choices: opts.choices.map((c) => ({
        name: c.name,
        value: c.value,
        ...(c.checked !== undefined && { checked: c.checked }),
        ...(c.description !== undefined && { description: c.description }),
      })),
    });
  },
};
