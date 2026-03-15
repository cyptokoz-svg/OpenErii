/**
 * Chinese translations for MCP tool descriptions.
 * Used by ToolsPage to override API-returned English descriptions when locale is 'zh'.
 * Key = tool name, value = Chinese description (first line only, keep concise).
 */
export const toolDescriptionsZh: Record<string, string> = {
  // thinking
  think: '分析当前市场状况和你的观察，整理思路。',
  plan: '根据分析结果规划下一步交易行动。',
  calculate: '执行精确的数学计算。',
  reportWarning: '检测到异常或意外情况时发出警告。',
  getConfirm: '执行操作前请求用户确认。',

  // trading
  listAccounts: '列出所有已注册的交易账户及其 ID、服务商和状态。',
  searchContracts: '在经纪商账户中搜索匹配模式的可交易合约。',
  getContractDetails: '从指定经纪商账户获取完整的合约规格。',
  getAccount: '查询交易账户信息（现金、组合价值、权益、购买力）。',
  getPortfolio: '查询当前持仓组合。',
  getOrders: '查询订单历史（已成交、待执行、已取消）。',
  getQuote: '查询合约的最新报价/价格。',
  getMarketClock: '获取当前市场时钟状态（是否开盘、下次开盘/收盘时间）。',
  tradingLog: '查看交易决策历史（类似 "git log --stat"）。',
  tradingShow: '查看某次交易提交的详情（类似 "git show"）。',
  tradingStatus: '查看当前交易暂存区状态（类似 "git status"）。',
  simulatePriceChange: '模拟价格变化以评估对投资组合的影响（只读）。',
  placeOrder: '暂存一个订单（执行 tradingPush 后生效）。',
  modifyOrder: '暂存一个订单修改（执行 tradingPush 后生效）。',
  closePosition: '暂存一个平仓操作（执行 tradingPush 后生效）。',
  cancelOrder: '暂存一个撤单操作（执行 tradingPush 后生效）。',
  tradingCommit: '提交暂存的交易操作并附带说明（类似 "git commit"）。',
  tradingPush: '执行所有已提交的交易操作（类似 "git push"）。',
  tradingSync: '从经纪商同步待处理订单状态（类似 "git pull"）。',

  // brain
  getFrontalLobe: '读取你上一轮的"工作记忆"——自我评估和观察。',
  updateFrontalLobe: '更新你的"前额叶"记忆空间，记录当前的自我评估。',
  getEmotion: '获取你当前的情绪状态和近期情绪变化。',
  updateEmotion: '当感知到市场情绪变化时更新你的情绪状态。',
  getBrainLog: '查看大脑提交历史——所有认知状态变化的时间线。',

  // browser
  browser: '浏览器工具：16 种操作、11 种子操作，Chrome 扩展中继、Docker 沙箱、远程节点代理。',

  // cron
  cronList: '列出所有定时任务。',
  cronAdd: '创建新的定时任务。',
  cronUpdate: '更新现有定时任务，仅修改提供的字段。',
  cronRemove: '永久删除一个定时任务。',
  cronRunNow: '手动立即触发一个定时任务，跳过其排程。',

  // market-search
  marketSearchForResearch: '跨资产类别搜索标的（股票、加密货币、外汇）。',

  // equity
  equityGetProfile: '获取公司简介和关键估值指标。',
  equityGetFinancials: '获取公司财务报表（利润表、资产负债表、现金流量表）。',
  equityGetRatios: '获取公司财务比率（盈利能力、流动性、杠杆率、效率）。',
  equityGetEstimates: '获取分析师一致预期。',
  equityGetEarningsCalendar: '获取即将发布和近期的财报日期。',
  equityGetInsiderTrading: '获取公司内部人交易活动。',
  equityDiscover: '发现当前市场热门股票（涨幅榜、跌幅榜、成交量榜）。',

  // news
  newsGetCompany: '获取指定公司的新闻。',

  // news-archive
  globNews: '按标题模式搜索新闻归档（类似 "ls"/"glob"）。',
  grepNews: '按内容模式搜索新闻归档（类似 "grep"）。',
  readNews: '按索引读取新闻全文（类似 "cat"）。',

  // analysis
  calculateIndicator: '计算任意资产的技术指标（SMA、EMA、RSI、BBANDS、MACD、ATR 等）。',

  // atlas
  atlasAnalysis: '运行 Atlas 投研团队分析（L1 宏观 → L2 行业 → L3 策略 → L4 决策）。',
  atlasScorecard: '查看 Atlas 代理绩效指标——夏普比率、胜率、信号数等。',
  atlasKnowledge: '搜索 Atlas 知识图谱（Obsidian vault）中积累的研究笔记。',
  atlasEvolve: '触发 Atlas 自研进化——找到表现最差的代理并自动优化。',
  atlasDepartments: '列出所有 Atlas 投研部门、状态和上次运行时间。',

  // ccxt
  getFundingRate: '查询永续合约的当前资金费率。',
  getOrderBook: '查询合约的订单簿（市场深度）。',
}
