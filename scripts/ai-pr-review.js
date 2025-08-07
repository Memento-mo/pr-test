// scripts/ai-pr-review.js
import { Octokit } from '@octokit/rest';
// import { OpenAI } from 'openai';
import GigaChat from 'gigachat'
import { Agent } from 'node:https';

import * as process from 'process';
import * as fs from 'fs';
import 'dotenv/config'

// ---------- 1. Конфигурация ----------
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const GIGACHAT_API_KEY = process.env.GIGACHAT_API_KEY;

if (!GITHUB_TOKEN) {
  console.error('❌ GITHUB_TOKEN missing!');
  process.exit(1);
}
if (!DEEPSEEK_API_KEY) {
  console.error('❌ DEEPSEEK_API_KEY missing!');
  process.exit(1);
}

const httpsAgent = new Agent({
  rejectUnauthorized: false, // Отключает проверку корневого сертификата
  // Читайте ниже как можно включить проверку сертификата Мин. Цифры
});

// Octokit – работа с GitHub API
const octokit = new Octokit({
  auth: GITHUB_TOKEN,
});

// DeepSeek через openai‑клиент (указываем baseURL)
// const openai = new OpenAI({
//   apiKey: DEEPSEEK_API_KEY,
//   baseURL: 'https://api.deepseek.com/v1', // <-- важный момент
// });

const gigachat = new GigaChat({
    timeout: 600,
    model: 'GigaChat',
    credentials: GIGACHAT_API_KEY,
    httpsAgent: httpsAgent
})
// Параметры окружения, переданные из workflow
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME  = process.env.REPO_NAME;
const PR_NUMBER  = Number(process.env.PR_NUMBER);

if (!PR_NUMBER) {
  console.error('❌ PR_NUMBER не задан!');
  process.exit(1);
}

// ---------- 2. Получаем diff ----------
async function fetchPrDiff(owner, repo, number) {
  const { data: files } = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });

  const diffs = [];

  for (const file of files) {
    // Пропускаем огромные бинарные файлы (patch === null)
    if (file.patch) {
      diffs.push({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch,
      });
    } else {
      diffs.push({
        filename: file.filename,
        status: file.status,
        note: '(binary or too large – diff not available)',
      });
    }
  }
  return diffs;
}

// ---------- 3. Формируем prompt ----------
function buildPrompt(prInfo, diffs) {
  const MAX_PATCH_LENGTH = 4000; // ~4 KB – в пределах токен‑лимита DeepSeek‑coder

  const diffTexts = diffs
    .map(f => {
      if (f.patch) {
        const truncated = f.patch.length > MAX_PATCH_LENGTH
          ? `${f.patch.slice(0, MAX_PATCH_LENGTH)}\n... (truncated)`
          : f.patch;
        return `File: ${f.filename}
Status: ${f.status}
--- diff start ---
${truncated}
--- diff end ---`;
      }
      return `File: ${f.filename}
Status: ${f.status}
Note: ${f.note}`;
    })
    .join('\n\n');

  // Prompt, ориентированный на DeepSeek‑coder (код‑ориентированная модель)
  return `
You are an experienced software engineer reviewing a pull request. 
Provide a concise, constructive review in **Markdown** that covers:

* Potential bugs or runtime errors
* Code‑style / lint issues
* Performance or complexity concerns
* Security considerations
* Suggestions for improvement (optional code snippets)

PR title: "${prInfo.title}"
PR description:
${prInfo.body || '(no description)'}

Changed files (diffs):
${diffTexts}
`;
}

// ---------- 4. Запрос к DeepSeek ----------
async function getAiReview(prompt) {
//   const response = await openai.chat.completions.create({
//     model: 'deepseek-chat',    // либо 'deepseek-chat' если нужен более общие ответы
//     messages: [{ role: 'user', content: prompt }],
//     temperature: 0.2,           // более детерминированные ответы
//     max_tokens: 1500,           // адаптируйте под ваши лимиты
//   });
  const response = await gigachat.chat({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 1500,
  });

  const answer = response.choices?.[0]?.message?.content?.trim();
  if (!answer) {
    throw new Error('Empty response from DeepSeek');
  }
  return answer;
}

// ---------- 5. Публикуем review ----------
async function postReview(owner, repo, number, body) {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: number,
    event: 'COMMENT', // можно заменить на 'APPROVE' / 'REQUEST_CHANGES'
    body,
  });
}

// ---------- 6. Основной процесс ----------
(async () => {
  try {
    // 6.1 – детали PR
    const { data: pr } = await octokit.pulls.get({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      pull_number: PR_NUMBER,
    });

    // 6.2 – diff
    const diffs = await fetchPrDiff(REPO_OWNER, REPO_NAME, PR_NUMBER);

    // 6.3 – prompt
    const prompt = buildPrompt(pr, diffs);

    // 6.4 – LLM‑ответ
    const reviewBody = await getAiReview(prompt);

    // 6.5 – отправка review
    await postReview(REPO_OWNER, REPO_NAME, PR_NUMBER, reviewBody);

    console.log('✅ AI review успешно опубликован.');
  } catch (err) {
    console.error('❌ Ошибка при генерации AI‑review:', err);
    process.exit(1);
  }
})();
