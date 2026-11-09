/**
 * Bundle entry: register the reading panel, its sidebar entry, and the locale
 * dictionary, then start the store. This part runs last; the loader materialises
 * every earlier part first.
 */

/** Short shared labels; longer view copy lives beside its component via `tr()`. */
const RD_DICT = {
  zh: {
    'common.close': '关闭',
    'common.cancel': '取消',
    'common.save': '保存',
    'common.delete': '删除',
    'common.retry': '重试',
    'common.copy': '复制',
    'common.edit': '编辑',
    'common.done': '完成',
    'shelf.title': '阅读',
    'shelf.import': '导入 EPUB',
    'shelf.empty.title': '书架还是空的',
    'shelf.empty.desc': '导入一本本地 EPUB 开始阅读；书会保存在 Host 的阅读目录里，换浏览器也不会丢。',
    'notes.title': '笔记',
    'reader.toc': '目录',
    'reader.settings': '阅读设置',
    'ask.title': '问 AI',
    'ask.placeholder': '就这段原文提问…',
    'ask.send': '提问',
    'ask.saveNote': '存为笔记',
    'ask.conversation': '带入对话',
    'search.placeholder': '搜索正文…',
  },
  en: {
    'common.close': 'Close',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.retry': 'Retry',
    'common.copy': 'Copy',
    'common.edit': 'Edit',
    'common.done': 'Done',
    'shelf.title': 'Reading',
    'shelf.import': 'Import EPUB',
    'shelf.empty.title': 'Your shelf is empty',
    'shelf.empty.desc': 'Import a local EPUB to start reading. Books are stored in the Host reading library, so they survive browser changes.',
    'notes.title': 'Notes',
    'reader.toc': 'Contents',
    'reader.settings': 'Reading settings',
    'ask.title': 'Ask AI',
    'ask.placeholder': 'Ask about this passage…',
    'ask.send': 'Ask',
    'ask.saveNote': 'Save as note',
    'ask.conversation': 'Continue in chat',
    'search.placeholder': 'Search text…',
  },
}

const readingPlugin = {
  inject: ['slots', 'locale'],
  apply(ctx) {
    const locale = ctx.get('locale')
    if (locale && typeof locale.register === 'function') {
      try {
        ctx.effect(() => locale.register('reading', RD_DICT), 'reading: dictionary')
        if (typeof locale.bind === 'function') {
          const bound = locale.bind('reading')
          translate = bound
          translateFn = bound
        }
        const syncLanguage = () => {
          try {
            setActiveLanguage(locale.getLocale())
          } catch {
            // A locale snapshot may not be readable before the tree settles.
          }
        }
        syncLanguage()
        if (typeof locale.subscribe === 'function') {
          ctx.effect(() => locale.subscribe(syncLanguage), 'reading: locale subscription')
        }
      } catch (error) {
        console.warn('[reading] locale registration failed:', error)
      }
    }

    createReadingStore(ctx)

    ctx.slots.inject('main', () =>
      ctx.slots.register({ name: 'main', key: 'reading', locale: 'reading' }, ReadingPanel),
    )

    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: 'reading',
          order: 30,
          locale: 'reading',
          label: () => tr('阅读', 'Reading'),
        },
        ReadingSidebarIcon,
      ),
    )
  },
}

return readingPlugin
