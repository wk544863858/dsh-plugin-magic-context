## 摘要 / Summary

<!-- 这个 PR 做了什么、为什么。关联 issue：Fixes #<issue> -->

## 变更内容 / What changed

<!-- 改动点列表。涉及行为变更时，请说明前后差异，以及是否影响已发布的行为契约。 -->

## 测试方式 / How tested

- [ ] `npm run typecheck`
- [ ] `npm test`（vitest，73 个 spec / 761 个用例）
- [ ] `npm run gate`（完整本地闸门：typecheck + suite + build + acceptance + 记忆审计 + records）
- [ ] `npm run check:i18n`（改动了客户端文案 / 字典时必跑）

补充说明（新增或修改的测试、手工验证步骤、截图等）：

## 检查清单 / Checklist

- [ ] 测试通过（本地 `npm run gate` 通过；CI 为绿）
- [ ] 没有提交密钥、token、cookie、个人绝对路径或未脱敏的日志
- [ ] 相关文档已更新（README / docs/ / CHANGELOG.md，视改动而定）
- [ ] 提交信息符合 Conventional Commits（`feat` / `fix` / `docs` / `refactor` / `test` / `chore`，subject 用中文）
- [ ] diff 聚焦：没有混入无关的格式化、重命名或重构

## 备注 / Notes

<!-- 给 reviewer 的额外上下文；没有可以删掉这一节。 -->
