# Luogu RMJ Submit Script

在洛谷编写代码，通过自己的远程评测站点账号提交，并在洛谷评测记录页查看该题的提交记录。每个站点对应一个独立的 Tampermonkey 用户脚本。

## 安装

在浏览器中启用 Tampermonkey，然后打开所需脚本的安装链接并确认安装。

| 评测站点 | 版本 | 安装 |
| --- | --- | --- |
| AtCoder | 1.3.4 | [安装脚本](https://raw.githubusercontent.com/TH911/Luogu-RMJ-Submit-Script/main/script/release/luogu-atcoder.user.js) |
| Codeforces | 1.1.7 | [安装脚本](https://raw.githubusercontent.com/TH911/Luogu-RMJ-Submit-Script/main/script/release/luogu-codeforces.user.js) |
| SPOJ | 1.0.4 | [安装脚本](https://raw.githubusercontent.com/TH911/Luogu-RMJ-Submit-Script/main/script/release/luogu-spoj.user.js) |
| UVa Online Judge | 1.0.2 | [安装脚本](https://raw.githubusercontent.com/TH911/Luogu-RMJ-Submit-Script/main/script/release/luogu-uva.user.js) |

## 使用

1. 登录对应的远程评测站点，打开洛谷上对应的题目，在洛谷提交页编写代码、选择语言并提交。
2. 如果远程站点要求登录或人机验证，切换到脚本打开的标签页，按站点提示完成操作。
3. 在洛谷的题目评测记录页，点击对应站点的刷新按钮查看本题提交。

脚本会在浏览器标签页之间临时传递代码和提交状态，并通过远程站点的页面提交代码。请先确认所登录的账号和所选语言。

## 版本发布

更新脚本时，同步更新脚本的 `@version` 和安装表中的版本号，并在 GitHub 发布 Release，注明更新的脚本和版本。
