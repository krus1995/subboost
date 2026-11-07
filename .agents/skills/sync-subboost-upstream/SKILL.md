---
name: sync-subboost-upstream
description: 用户要求同步 SubBoost 上游正式版本、指定 tag 或提交时，在本地固定目标、合并、验证并跟进 PR。
---

读 AGENTS.md、STATE.md、FEATURES.md 和执行手册第 7 节。在干净的任务 worktree 运行 `bash ops/fork/sync-upstream.sh`；指定 tag 或完整 SHA 时将其作为唯一参数。脚本只获取上游对象及本 fork 的分支，不向远端推送。记录输出 B、U、分支名和目标。

- no-op 表示 B 已包含 U，记录结果后结束。已有本地或远端任务分支时脚本会接续它，使用 `gh pr list --base main --head "$branch"` 找对应 PR。
- 冲突时查看 `git status` 和三方版本，对照定制清单逐文件解决冲突并完成合并。将理由记入 STATE.md。检查 merge-base 到 U 的 workflow、项目规则、发布脚本和数据库迁移差异。
- 正式版已包含时更新 ops/fork/config.json 中的 upstreamTag、upstreamCommit。用户指定开发提交时保留最近已包含的正式版，另行记录 U。检查 B 与 U 都是候选祖先，再运行 verify-subboost。
- 记录独立审查者、base、head、阻塞项和修复结果。推送该任务分支，创建或更新 PR，用本地身份执行 `gh pr checks "$pr" --required --watch`。确认 fork-required 已出现在当前 PR 并通过，base 变化时合入最新 main，更新验证与审查。用 `gh pr merge "$pr" --merge --match-head-commit "$head"` 合并。
- 获取远端 main 并核对 U 已包含。按 deploy-subboost 跟进 Actions 和生产回执，记录生产 SHA、image ID 和业务验收。
