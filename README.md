# AIX client libraries

Client libraries for the [Agentic Intent Exchange (AIX)](https://www.brambles.ai/agentic-intent-exchange), the exchange Brambles.ai operates. AIX carries a shopper's brief from a sending agent to the one receiving agent the shopper is going to, as a signed receipt.

| Package | Language | Install | Directory |
| --- | --- | --- | --- |
| `@brambles-ai/aix` | TypeScript and JavaScript, Node 18 or later | `npm install @brambles-ai/aix` | [`packages/aix-js`](packages/aix-js) |
| `brambles-aix` | Python 3.10 or later | `pip install brambles-aix` | [`packages/aix-python`](packages/aix-python) |

## What they do

Both libraries call the AIX HTTPS API at `https://aix.brambles.ai/api/aix` from your server.

- **Sending agents:** send the shopper's current task, report the store you send them to, and get the store URL to put inside your own link.
- **Receiving agents:** verify a webhook delivery and its signed receipt, acknowledge it, load the brief, redeem a handoff id from a landing or a completed order, and report a sale.
- **Framework adapters:** the two sender tools for the Vercel AI SDK, the OpenAI Agents SDK and LangChain.

Each package has its own README with examples and a table of every function.

## You need a key

The libraries do nothing without a key from the AIX console.

- Sign up to [send intent](https://www.brambles.ai/agentic-intent-exchange/connect?role=sender) or to [receive intent](https://www.brambles.ai/agentic-intent-exchange/connect?role=receiver).
- Sandbox keys are free. They never reach a real store, never earn and never spend.
- Keys are server secrets. Never put one in browser code, a model prompt, a log or a commit.

## More

- Docs: https://www.brambles.ai/agentic-intent-exchange/docs
- API description, format files, skills and the white paper: https://github.com/brambles-ai/agentic-intent-exchange
- A coding agent can set up an integration for you without these libraries: `npx skills add https://aix.brambles.ai`

## Rights

These libraries may be used only to connect to AIX, under the AIX terms. See [LICENSE](LICENSE). AIX is the subject of a US provisional patent application. © Brambles.ai.
