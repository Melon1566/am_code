# Codex

Use your ChatGPT plan or an existing Codex CLI login to code in T3 Code.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers**. For a remote machine,
select that environment first. T3 Code handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

Manage shared usage and credits in ChatGPT through **Manage usage** in T3 Code.
If a request uses a feature that ChatGPT sharing does not support, use another
provider for that request.

When reconnecting, choose the same account in T3 Code and on OpenAI's sign-in
page. Disconnecting stops running threads but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

T3 Code can use your installed Codex and its existing login. Run `codex login`
on the environment's machine to sign in. [Provider setup](./install.md#providers)
covers installation and custom configuration.

## Recover interrupted work

If Codex exits unexpectedly during a turn, or a turn fails because of a temporary
connection or server error, T3 Code automatically resumes the saved conversation
and continues working. The activity feed shows recovery attempts. You can leave
the client disconnected; recovery runs on the machine hosting T3 Code.

Recovery retries after 5, 15, 30, 60, and 120 seconds. A completed turn resets this
limit. **Stop** cancels pending recovery. Authentication, permission, quota, and
context-limit errors need your attention, as does a conversation that cannot be
restored. After recovery runs out of attempts, send a message to try again.

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers**, then select the account
from the thread's model picker. Compatible accounts can continue the same thread.
Connecting accounts through T3 Code leaves your CLI login unchanged.

### Multiple CLI logins

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. In **Settings → Providers**, add another
Codex instance using an existing CLI login. Keep the same **CODEX_HOME path** and
give the new account its own **Shadow home path**. T3 Code creates the shadow
directory and prepares the shared state; do not populate it by copying your
whole Codex home.

Sign in from the wizard or provider settings. For a remote host, select
**ChatGPT with device code** under **Sign-in method** to enter a short code from
any device without needing a browser on the host.

The same sign-in and **Sign out** controls are on each Codex instance in
**Settings → Providers**, so you can sign in later or switch the account behind an
instance.

To sign in from a terminal instead, point Codex at the shadow directory for one login:

```bash
CODEX_HOME=~/.codex-t3/codex_personal codex login
```

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3 Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Balance usage across accounts

Turn on **Balance usage with pooled accounts** for every Codex instance that shares
a CODEX_HOME path and should share the work. New threads start on the pooled
account with the most session quota left. A thread stays on its account until that
account's session or weekly limit runs out. The next message then continues on
another pooled account, and the thread notes the switch. The model picker shows
the account in use.

Turn the switch off on an instance to leave it out of the pool. Threads keep the
account they last used.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner. With pooled accounts, sending the message again
continues on another account that still has quota.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
