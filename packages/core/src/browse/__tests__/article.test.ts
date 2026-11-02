import { describe, expect, it } from 'vitest'
import { extractArticle, isProbablyEmpty } from '../article'

describe('提取标题', () => {
  it('优先用 title', () => {
    const a = extractArticle('<html><head><title>标题一</title></head><body><h1>标题二</h1></body></html>')
    expect(a.title).toBe('标题一')
  })

  it('没有 title 时退回 h1', () => {
    const a = extractArticle('<body><h1>只有一级标题</h1><p>正文</p></body>')
    expect(a.title).toBe('只有一级标题')
  })

  it('都没有时是空串', () => {
    expect(extractArticle('<p>正文</p>').title).toBe('')
  })

  it('标题里的实体被解开', () => {
    const a = extractArticle('<title>A &amp; B</title>')
    expect(a.title).toBe('A & B')
  })
})

describe('丢弃不要的部分', () => {
  it('script 内容不出现', () => {
    const a = extractArticle('<body><p>正文</p><script>var secret = 1</script></body>')
    expect(a.text).toBe('正文')
    expect(a.text).not.toContain('secret')
  })

  it('style 内容不出现', () => {
    const a = extractArticle('<body><style>.x { color: red }</style><p>正文</p></body>')
    expect(a.text).toBe('正文')
  })

  it('导航与页脚不出现', () => {
    const html = '<body><nav>首页 关于</nav><p>正文</p><footer>版权所有</footer></body>'
    const a = extractArticle(html)
    expect(a.text).toBe('正文')
  })

  it('侧栏不出现', () => {
    const a = extractArticle('<body><aside>相关推荐</aside><p>正文</p></body>')
    expect(a.text).toBe('正文')
  })

  it('注释不出现', () => {
    const a = extractArticle('<body><!-- 内部备注 --><p>正文</p></body>')
    expect(a.text).toBe('正文')
  })

  it('表单整块丢掉', () => {
    const a = extractArticle('<body><form><input value="x"><button>提交</button></form><p>正文</p></body>')
    expect(a.text).toBe('正文')
  })
})

describe('段落与空白', () => {
  it('两个段落之间空一行', () => {
    const a = extractArticle('<body><p>第一段</p><p>第二段</p></body>')
    expect(a.text).toBe('第一段\n\n第二段')
  })

  it('行内连续空白折成一个空格', () => {
    const a = extractArticle('<p>这里   有    很多空格</p>')
    expect(a.text).toBe('这里 有 很多空格')
  })

  it('首尾空白被去掉', () => {
    const a = extractArticle('<p>   \n 正文 \n  </p>')
    expect(a.text).toBe('正文')
  })

  it('连续空行压成一个', () => {
    const a = extractArticle('<p>一</p><div></div><div></div><p>二</p>')
    expect(a.text).toBe('一\n\n二')
  })

  it('列表项各占一行', () => {
    const a = extractArticle('<ul><li>甲</li><li>乙</li></ul>')
    expect(a.text).toBe('甲\n\n乙')
  })
})

describe('实体解码', () => {
  it('常见命名实体', () => {
    const a = extractArticle('<p>&lt;tag&gt; &quot;引号&quot; &nbsp;空格</p>')
    expect(a.text).toBe('<tag> "引号" 空格')
  })

  it('数字实体', () => {
    const a = extractArticle('<p>&#65;&#x42;</p>')
    expect(a.text).toBe('AB')
  })

  it('不认识的实体原样保留，不猜', () => {
    const a = extractArticle('<p>&unknownentity;</p>')
    expect(a.text).toBe('&unknownentity;')
  })

  it('非法码点不崩，原样保留', () => {
    const a = extractArticle('<p>&#x110000;</p>')
    expect(a.text).toBe('&#x110000;')
  })
})

describe('元信息', () => {
  it('读到 lang', () => {
    expect(extractArticle('<html lang="zh-CN"><body>x</body></html>').lang).toBe('zh-CN')
  })

  it('没有 lang 时为 null', () => {
    expect(extractArticle('<body>x</body>').lang).toBeNull()
  })

  it('length 不算空白', () => {
    const a = extractArticle('<p>一二 三</p>')
    expect(a.length).toBe(3)
  })
})

describe('空页面判定', () => {
  it('只有脚本挂载点的页面被判为空', () => {
    const a = extractArticle('<html><body><div id="app"></div><script src="x.js"></script></body></html>')
    expect(isProbablyEmpty(a)).toBe(true)
  })

  it('有正文的不算空', () => {
    const a = extractArticle(`<body><p>${'正文内容'.repeat(30)}</p></body>`)
    expect(isProbablyEmpty(a)).toBe(false)
  })

  it('阈值可调', () => {
    const a = extractArticle('<p>十二个字的一段话</p>')
    expect(isProbablyEmpty(a, 3)).toBe(false)
    expect(isProbablyEmpty(a, 100)).toBe(true)
  })
})

describe('容错', () => {
  it('空字符串不崩', () => {
    const a = extractArticle('')
    expect(a.text).toBe('')
    expect(a.title).toBe('')
    expect(a.lang).toBeNull()
  })

  it('没有闭合标签也能取到文字', () => {
    const a = extractArticle('<p>未闭合')
    expect(a.text).toContain('未闭合')
  })

  it('大段中文正常处理', () => {
    const body = '这是一段中文正文，用来确认提取过程不会破坏汉字与标点。'
    const a = extractArticle(`<p>${body}</p>`)
    expect(a.text).toBe(body)
  })
})
