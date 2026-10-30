# Free AI API রাডার — ৩০ অক্টোবর ২০২৬

> প্রশ্ন ছিল: **open code / cline / hermes-এর মতো ৫০+ agent + provider কোম্পানি নিয়ে রিয়েল-টাইমে analyze করা যায় কি? কোন provider ফ্রি টেস্টের জন্য মডেল দিচ্ছে, মোট কতগুলো, আর ফ্রি API দিয়ে নিজের প্রজেক্ট বানানো যাবে কি?**
>
> উত্তর: **হ্যাঁ, যায় — এবং এখানে সেটারই রিপো।** এই ফোল্ডারে দুই ভাগ আছে:
> 1. **তথ্য** — ৩২টি provider + ৬৯টি GitHub agent repo-র লাইভ snapshot (আজ, 2026-10-30 তারিখে টানা)।
> 2. **টুল** — যে স্ক্রিপ্ট দিয়ে আপনি *নিজে* আবার যাচাই করতে পারবেন, কারণ ফ্রি টিয়ার প্রায় প্রতি সপ্তাহে বদলায়।

---

## ১. এক নজরে (TL;DR)

| প্রশ্ন | সংক্ষিপ্ত উত্তর |
|---|---|
| ফ্রি API দেয় এমন provider কতগুলো? | **স্থায়ী (standing) ফ্রি টিয়ার ≈ ২৫টি**, ট্রায়াল ক্রেডিট মিলিয়ে **৩০–৪০টি**। এই রিপোতে **৩২টি** ট্র্যাক করা আছে ([PROVIDERS.md](PROVIDERS.md)) |
| ফ্রি মডেল কতগুলো? | ডিরেক্টরিগুলো **৫৪১টি ফ্রি মডেল / ৩১ provider** ([freellm.net](https://freellm.net/providers/)) আর **১৩৪+ ফ্রি API / ৪০+ provider** ([awesome-freellm](https://github.com/open-free-llm-api/awesome-freellm-apis)) গুনছে — এর বড় অংশ রোটেটিং প্রোমো |
| কার্ড লাগে? | ৩২টির মধ্যে **২৯টিতে কার্ড লাগে না**, শুধু ইমেইল/ফোন |
| সবচেয়ে বড় ফ্রি কোটা? | **Cerebras** — দিনে ১০ লাখ টোকেন, ৩০ RPM, কার্ড ছাড়া ([সূত্র](https://tokenmix.ai/blog/cerebras-api-key-rate-limits-free-tier-2026)) |
| সবচেয়ে বেশি মডেল? | **NVIDIA NIM** (~১৩০ মডেল, ভিজ্যুয়াল/এমবেডিং/রির্যাঙ্ক সহ), তারপর **ModelScope** (~৬০) |
| ফ্রি টিয়ার প্রোডাকশনে চলবে? | **না** — প্রোটোটাইপ/সাইড প্রজেক্টে হ্যাঁ, ইউজার ট্রাফিকে নয়। নিচে §৬ দেখুন |
| ৫০+ agent analyze? | **৬৯টি repo** লাইভ স্ক্যান করা হয়েছে — ৪৩ লাখ স্টার, লাইসেন্স + শেষ push সহ ([AGENTS.md](AGENTS.md)) |

---

## ২. টপ ফ্রি API — কোনটা কী কাজে

| Provider | ফ্রি মডেল (নমুনা) | ফ্রি লিমিট | কার্ড | Base URL |
|---|---|---|---|---|
| **Groq** | gpt-oss-120b/20b, Qwen3-27B, Llama 3.1 8B, Whisper | ৩০ RPM · ১,০০০ RPD/বড় মডেল · **১৪,৪০০ RPD** ছোট Llama-তে | না | `https://api.groq.com/openai/v1` |
| **Cerebras** | Llama 4 Scout, Qwen3-235B, gpt-oss-120b | **১০ লাখ টোকেন/দিন**, ৩০ RPM (ফ্রি কনটেক্সট ~8k) | না | `https://api.cerebras.ai/v1` |
| **Google AI Studio** | Gemini 3.x Flash / Flash-Lite, Gemma | প্রজেক্ট-প্রতি ~১.৫k RPD ক্লাস, ১০ লাখ কনটেক্সট | না | `.../v1beta/openai/` |
| **NVIDIA NIM** | Nemotron, GLM, Qwen, DeepSeek, rerank, vision | ফোন ভেরিফাই + প্রতি-মডেল ক্রেডিট/RPM | না | `https://integrate.api.nvidia.com/v1` |
| **Cloudflare Workers AI** | Llama, Kimi, Mistral, Flux, Whisper | **১০,০০০ নিউরন/দিন** (মডেলভেদে খরচ আলাদা) | না | `.../accounts/{id}/ai/v1` |
| **Mistral** | Mistral Small/Medium, Codestral, OCR | ~১ RPS, ~১B টোকেন/মাস রিপোর্টেড | না | `https://api.mistral.ai/v1` |
| **OpenRouter** | ~৩৫টি `:free` রুট | $১০-এর নিচে **৫০ req/দিন**, একবার $১০ টপ-আপে **১,০০০/দিন** | না | `https://openrouter.ai/api/v1` |
| **GitHub Models** | GPT-4o/4.1, Claude class, Llama, DeepSeek-R1 | ১৫ RPM/১৫০ RPD (low tier), ১০ RPM/৫০ RPD (high) | না (PAT) | `https://models.github.ai/inference` |
| **Ollama Cloud** | gpt-oss, Qwen3, DeepSeek, Kimi, GLM (~১৭) | ফ্রি ঘণ্টা/দিন কোটা (সংখ্যা প্রকাশ করে না) | না | `https://ollama.com/v1` |
| **Nous Portal (Hermes)** | `step-3.7-flash:free`, `laguna-s/xs`, `longcat-2.x`, `solar-mini-4` | শুধু `:free` SKU, ~৫০ RPM / ৫০০k TPM রিপোর্টেড | না | `https://inference-api.nousresearch.com/v1` |
| **OpenCode Zen** | grok-code-fast-1, big-pickle, MiniMax M2.x, GLM | প্রোমো মডেল $০, লিমিট প্রকাশিত নয় | না | `https://opencode.ai/zen/v1` |
| **Kilo Code Gateway** | Nemotron 3 Ultra, Laguna, North mini code | ~২০০ req/ঘণ্টা, ১M কনটেক্সট | না | `https://api.kilo.ai/api/gateway` |
| **Hugging Face Router** | Llama, Qwen, DeepSeek + ইমেজ | মাসিক ইনফারেন্স ক্রেডিট | না | `https://router.huggingface.co/v1` |
| **LLM7.io / Pollinations** | মিক্সড ওপেন + ইমেজ | ~৩০ RPM; Pollinations একদম **keyless** | না | `https://api.llm7.io/v1` |
| **Cohere** | Command, Embed, **Rerank** | ট্রায়াল কী: ২০ RPM, ~১,০০০/মাস | না | `https://api.cohere.com/compatibility/v1` |

পুরো ৩২টি (ট্রায়াল, চীনা ল্যাব, গেটওয়ে সহ) → **[PROVIDERS.md](PROVIDERS.md)** · মেশিন-রিডেবল → `data/providers.json`

**আপনার প্রজেক্টের জন্য $০ স্ট্যাক (প্র্যাকটিক্যাল):**

```
চ্যাট / সাধারণ কাজ   → Groq (গতি)  → Cerebras (ভলিউম)  → Gemini (১০ লাখ কনটেক্সট)
বৈচিত্র্য / ফলব্যাক   → OpenRouter :free  → Nous :free  → Ollama Cloud
RAG / সার্চ          → Gemini embedding  → Cloudflare bge  → Cohere rerank (ট্রায়াল)
স্পিচ-টু-টেক্সট      → Groq Whisper  → Cloudflare Whisper
ইমেজ                 → Pollinations (keyless)  → Cloudflare Flux
একেবারে অফলাইন       → Ollama / llama.cpp (লোকাল, কোনো লিমিট নেই)
```

---

## ৩. কোন agent / CLI ফ্রি মডেল দেয়

কোডিং টুলগুলোর নিজের সাবস্ক্রিপশন না কিনেও ফ্রি লেন পাওয়া যায় — কিন্তু বেশিরভাগ ক্ষেত্রে **API key generalize করা যায় না**, ওগুলো শুধু ওই টুলের ভেতরে কাজ করে:

| Agent / CLI | ফ্রি কী দেয় | API key দিয়ে বাইরে ব্যবহার? |
|---|---|---|
| **OpenCode** + Zen | grok-code-fast-1, big-pickle, MiniMax, GLM ($০ প্রোমো) | হ্যাঁ — Zen OpenAI-compatible |
| **Kilo Code** | ~২৯ ফ্রি মডেল, ~২০০ req/ঘণ্টা | হ্যাঁ — gateway endpoint |
| **Cline** | রোটেটিং FREE SKU (mimo, solar-mini) | না — শুধু CLI/IDE প্রোমো |
| **Qwen Code** | Qwen OAuth দিয়ে বড় ফ্রি কোটা | না |
| **Gemini CLI** | Gemini Flash ফ্রি কোটা | আংশিক (AI Studio key) |
| **GitHub Copilot Free** | মাসিক সীমিত chat/completion | না |
| **Kiro / Google Antigravity / Qoder / Trae / CodeBuddy** | লঞ্চ প্রোমো (Claude/Gemini/GPT class) | না |
| **Nous Hermes Agent** | `:free` মডেল (MIT লাইসেন্স, যেকোনো provider-এ চালানো যায়) | হ্যাঁ — Portal OpenAI-compatible |
| **OpenHands / Goose / Aider / Continue / Crush** | BYOK — নিজের ফ্রি key বসাতে হয় | হ্যাঁ |

> নিয়ম: **টুলের ভেতরের ফ্রি ≠ ফ্রি API।** নিজের অ্যাপ বানাতে চাইলে §২-এর provider লিস্ট ব্যবহার করুন, টুলের প্রোমো নয়।

---

## ৪. ৫০+ agent — লাইভ GitHub স্ক্যান

`scripts/agent_radar.py` GitHub API দিয়ে repo-গুলো টেনে আনে (স্টার, ফর্ক, লাইসেন্স, শেষ push, archived কি না)। আজকের রান: **৬৯/৬৯ repo resolve হয়েছে, মোট ৪৩,১১,৯৩২ স্টার**।

<!-- TOP15:START -->
| # | Repo | Stars | Licence | Category |
|---:|---|---:|---|---|
| 1 | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 258,676 | MIT | coding-agent |
| 2 | [anomalyco/opencode](https://github.com/anomalyco/opencode) | 223,168 | MIT | coding-agent |
| 3 | [n8n-io/n8n](https://github.com/n8n-io/n8n) | 209,094 | custom | platform |
| 4 | [Significant-Gravitas/AutoGPT](https://github.com/Significant-Gravitas/AutoGPT) | 187,826 | custom | agent-framework |
| 5 | [ollama/ollama](https://github.com/ollama/ollama) | 185,320 | MIT | local-runtime |
| 6 | [langgenius/dify](https://github.com/langgenius/dify) | 159,983 | custom | platform |
| 7 | [langflow-ai/langflow](https://github.com/langflow-ai/langflow) | 156,157 | MIT | platform |
| 8 | [anthropics/claude-code](https://github.com/anthropics/claude-code) | 153,913 | - | coding-agent |
| 9 | [langchain-ai/langchain](https://github.com/langchain-ai/langchain) | 148,705 | MIT | agent-framework |
| 10 | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | 132,820 | MIT | local-runtime |
| 11 | [openai/codex](https://github.com/openai/codex) | 131,654 | Apache-2.0 | coding-agent |
| 12 | [browser-use/browser-use](https://github.com/browser-use/browser-use) | 119,550 | MIT | web-agent |
| 13 | [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | 108,627 | Apache-2.0 | coding-agent |
| 14 | [vllm-project/vllm](https://github.com/vllm-project/vllm) | 95,901 | Apache-2.0 | local-runtime |
| 15 | [infiniflow/ragflow](https://github.com/infiniflow/ragflow) | 93,175 | Apache-2.0 | platform |
<!-- TOP15:END -->

বাকি ৫৪টি (LiteLLM, Portkey, Dify, Roo Code, Crush, Cline, Dify, MCP servers, LiveKit, Pipecat…) → **[AGENTS.md](AGENTS.md)**

ক্যাটাগরি ব্রেকডাউন: coding-agent ২৪ · agent-framework ১৮ · local-runtime ৬ · platform ৫ · gateway ৪ · mcp ৩ · web-agent ২ · editor ২ · voice-agent ২ · router/sdk/tooling ৩

**নিজে চালাতে:**

```bash
python3 scripts/agent_radar.py          # ৬৯ repo, ~২ মিনিট, GITHUB_TOKEN বা `gh auth token` ব্যবহার করে
```

নতুন repo যোগ করতে `data/agent_repos.json`-এ এক লাইন — ব্যস। ৫০ নয়, ৫০০ repo-ও স্ক্যান করবে।

---

## ৫. এই ফোল্ডারে কী কী

```
free-ai-radar/
├── README.md                  ← এই রিপোর্ট
├── PROVIDERS.md               ← ৩২ provider-এর ফুল টেবিল (auto-generated)
├── AGENTS.md                  ← ৬৯ agent repo-র লাইভ স্ট্যাট (auto-generated)
├── HEALTH.md                  ← আপনার key দিয়ে চালানো শেষ health check
├── .env.example               ← কোন provider-এর কী env ভ্যারিয়েবলে বসবে
├── data/
│   ├── providers.json         ← provider-এর সোর্স অফ ট্রুথ (ফ্রি লিমিট, base URL, key page)
│   ├── agent_repos.json       ← স্ক্যান করার repo তালিকা
│   └── agents-live.json       ← শেষ স্ক্যানের ফলাফল
├── scripts/
│   ├── agent_radar.py         ← GitHub লাইভ স্ক্যান → agents-live.json + AGENTS.md
│   ├── check_providers.py     ← আপনার key দিয়ে /models + chat probe → HEALTH.md
│   └── render_tables.py       ← providers.json → PROVIDERS.md
└── examples/
    └── fallback_router.py     ← এক ফাংশন, ৭টি lane, 429 হলে পরেরটায় ফলব্যাক
```

### ৫ মিনিটে শুরু

```bash
cd free-ai-radar
cp .env.example .env            # যেগুলো key আছে শুধু সেগুলো ভরুন (একটাও না থাকলেও চলবে)

python3 scripts/check_providers.py          # কোন key জীবিত, কোনটা 429
python3 scripts/check_providers.py --chat   # + একটা ছোট completion

python3 examples/fallback_router.py "বাংলায় এক লাইনে বলো: ফ্রি API কী?"
```

`check_providers.py` যা করে: প্রতিটি provider-এ `GET /models` (Bearer key) → key বৈধ কি না, কত মডেল, কত ms। `--chat` দিলে একটা ৮-টোকেনের রিপ্লাইও চায়। কোনো key নেই → `skip`, ভুল key → `bad-key`, কোটা শেষ → `rate-limited`।

---

## ৬. ফ্রি টিয়ারের ৭টি ফাঁদ (এগুলো না জানলে প্রজেক্ট ভাঙবে)

1. **লিমিট per-project, per-key নয়।** Gemini-তে একই প্রজেক্টে ১০টা key বানালে কোটা বাড়ে না।
2. **TPM আসল সিলিং।** ৩০ RPM + ৮k TPM মানে মিনিটে ~৪টা নরমাল রিপ্লাই — RPM দেখে খুশি হবেন না।
3. **প্রোমো মডেল হঠাৎ উধাও।** `:free` / FREE SKU (OpenRouter, OpenCode Zen, Nous, Kilo, Cline) রোটেট করে; কোডে free model id হার্ডকোড করবেন না — `data/providers.json` থেকে পড়ুন।
4. **ফ্রি = ডেটা ট্রেনিং (প্রায়ই)।** Gemini free tier স্পষ্ট বলছে কনটেন্ট প্রোডাক্ট ইমপ্রুভ করতে ব্যবহার হতে পারে; GitHub Models-এ Microsoft data terms। সেনসিটিভ ডেটা দিলে লোকাল Ollama ব্যবহার করুন।
5. **ট্রায়াল ক্রেডিট ≠ ফ্রি টিয়ার।** Fireworks ($1), Nebius, Novita, DeepSeek, xAI — এগুলো একবার শেষ হলে আর আসে না। `PROVIDERS.md`-এ `_(trial)_` ট্যাগ দেওয়া আছে।
6. **মাল্টি-অ্যাকাউন্ট করে লিমিট বাইপাস = ToS ভঙ্গ।** ব্যান হয়, প্রজেক্টের key-ও মরে।
7. **কোনো SLA নেই।** ৫০৩/429 সাধারণ ব্যাপার — **ফলব্যাক ছাড়া এক provider-এর উপর নির্ভর করবেন না**; `examples/fallback_router.py` ঠিক এটার জন্য।

**প্রোডাকশনের নিয়ম:** ফ্রি টিয়ার = ডেভ + ডেমো + ব্যক্তিগত প্রজেক্ট। আসল ইউজার এলে হয় লোকাল মডেল (GPU ভাড়া), নয়তো সস্তা পেইড (DeepSeek/Gemini Flash) — মাসে কয়েক ডলারেই ফ্রি লিমিটের ঝামেলা শেষ।

---

## ৭. যাচাই ও সূত্র

- স্ক্যানের সময়: **2026-10-30, UTC** (GitHub API লাইভ কল, ৬৯ repo)।
- ফ্রি লিমিটের সংখ্যাগুলো provider-এর নিজের pricing/rate-limit পেজ + ২০২৬-এর স্বাধীন প্রোবের মিলিত ফল — কোথাও কোথাও (বিশেষত Gemini) সূত্রে তারতম্য আছে, তাই `check_providers.py` দিয়ে নিজের অ্যাকাউন্টে যাচাই করুন।
- প্রধান সূত্র: [Groq rate limits](https://console.groq.com/docs/rate-limits) · [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Cerebras](https://www.cerebras.ai/pricing) · [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [OpenRouter free models](https://openrouter.ai/docs/api-reference/limits) · [GitHub Models](https://docs.github.com/en/github-models) · [Nous Portal](https://portal.nousresearch.com) · [OpenCode Zen](https://opencode.ai/docs/zen) · [freellm.net](https://freellm.net/providers/) · [awesome-free-ai-coding](https://mvalentsev.github.io/awesome-free-ai-coding/providers/) · [awesome-freellm-apis](https://github.com/open-free-llm-api/awesome-freellm-apis)

> **এক লাইনে:** ফ্রি API সত্যিই আছে — ২৫+ provider, ৫০০+ মডেল — কিন্তু ওগুলো *একসাথে একটাই সত্য* নয়: রোটেট করে, লিমিট বদলায়, আর ফ্রি টিয়ারে আপনার প্রম্পট ট্রেনিং ডেটা হতে পারে। তাই রিপো নয়, **প্রসেস** দরকার — এই রিপোর স্ক্রিপ্টগুলো ঠিক সেটাই: ফ্রি ল্যান্ডস্কেপ নিজে মেপে নিন, প্রতিদিন।
