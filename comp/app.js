const electron = require('electron')

const VueCompiler = require('vue-template-compiler/browser')
const ElementUI = require('element-ui')
const Router = require('vue-router')
const I18n = require('vue-i18n')
const Vuex = require('vuex')
const Vue = require('vue')

const NeatScroll = require('neat-scroll')

const pixivAPI = require('../pixiv')
const path = require('path')
const fs = require('fs')

// Use vue modules.
Vue.use(ElementUI)
Vue.use(Router)
Vue.use(I18n)
Vue.use(Vuex)

// Prevent vue from generating production tips.
Vue.config.productionTip = false

/**
 * Global environment of pxscope
 * 0: production mode.
 * 1: development mode.
 */
global.PX_ENV = 1

/**
 * Render function generator.
 * @param {string} filepath Template file path
 * @returns {Function} Render function
 */
global.$render = function(dirname, filename = 'index') {
  const filepath = path.join(dirname, filename)
  if (global.PX_ENV) {
    // Compile html into render functions.
    const html = fs.readFileSync(filepath + '.html', {encoding: 'utf8'})
    const result = VueCompiler.compileToFunctions(html).render
    fs.writeFileSync(filepath + '.html.js', 'module.exports = ' + result)
    return result
  } else {
    // Use compiled render functions.
    return require(filepath + '.html.js')
  }
}

const errorLog = []
/**
 * Append an error into error log.
 * @param {string} type Error type
 * @param {object} data Error information
 */
function $pushError(type, data) {
  if (data instanceof Object) {
    errorLog.push({ type, ...data })
  } else {
    errorLog.push({ type, data })
  }
}

/**
 * Load data from storage.
 * @param {string} item Item key
 * @param {any} fallback Fallback
 */
function $loadFromStorage(item, fallback = null) {
  const storage = localStorage.getItem(item)
  try {
    if (fallback) {
      return Object.assign(fallback, JSON.parse(storage))
    } else {
      return JSON.parse(storage)
    }
  } catch (error) {
    $pushError('Malformed JSON from LocalStorage', storage)
    return fallback
  }
}

Vue.prototype.$pushError = $pushError
Vue.prototype.$loadFromStorage = $loadFromStorage

const library = {
  i18n: require('../i18n'),
  themes: require('../themes'),
}

// Interprocess communication for envireonment.
electron.ipcRenderer.send('env', global.PX_ENV)
const browser = electron.remote.getCurrentWindow()

// Load settings and accounts from local storage.
const defaultSettings = require('../default')
const settings = $loadFromStorage('settings', {...defaultSettings})
const accounts = $loadFromStorage('accounts', [])

global.$pixiv = new pixivAPI({
  timeout: settings.timeout * 1000,
  language: settings.language,
})
$pixiv.authorize($loadFromStorage('auth'))
$pixiv.on('auth', auth => localStorage.setItem('auth', JSON.stringify(auth)))

// Neat-scroll implementation.
NeatScroll.config.speed = settings.scroll_speed
NeatScroll.config.smooth = settings.scroll_smooth
Vue.prototype.$neatScroll = (...args) => new NeatScroll(...args)
Vue.prototype.$neatScroll.config = NeatScroll.config

// Vuex
const store = new Vuex.Store({
  state: {
    settings,
    accounts,
  },
  mutations: {
    setSettings(state, settings) {
      Object.assign(state.settings, settings)
    },
    saveAccount(state, user) {
      const index = state.accounts.findIndex(account => account.id === user.id)
      if (index >= 0) {
        Object.assign(state.accounts[index], user)
      } else {
        state.accounts.push(user)
      }
    }
  }
})

// Global components
const components = ['loading']
components.forEach(name => Vue.component(name, require('./' + name)))

// Root router
const rootMap = {}
const roots = ['discovery', 'download', 'user', 'settings']
roots.forEach(root => rootMap[root] = '/' + root)

// Router
const routes = ['discovery', 'download', 'user', 'settings', 'user/login']
const router = new Router({
  routes: routes.map(route => ({
    name: route.match(/[\w-]+$/)[0],
    path: '/' + route,
    component: require('./' + route)
  }))
})

// Save browsering history.
router.afterEach(to => {
  if (to.path === '/') return
  rootMap[to.path.match(/^\/(\w+)/)[1]] = to.path
})

// I18n
const i18n = new I18n({
  locale: settings.language,
  fallbackLocale: 'en-US',
  messages: new Proxy({}, {
    get(target, key) {
      if (key in library.i18n && !(key in target)) {
        // Lazy loading i18n resources.
        target[key] = require(`../i18n/${key}.json`)
      }
      return Reflect.get(target, key)
    }
  })
})

module.exports = {
  el: '#app',
  i18n,
  store,
  router,

  provide: () => ({
    library,
  }),

  data: () => ({
    roots,
    routes,
    rootMap,
    loading: false,
    maximize: false,
    switching: false,
    scrollBarStyle: 'auto',
    enterDirection: 'none',
    leaveDirection: 'none',
    height: document.body.clientHeight - 48, // initial height
    width: document.body.clientWidth - 64, // initial width
  }),

  computed: {
    settings() {
      return this.$store.state.settings
    },
    currentRootIndex() {
      if (this.$route.path === '/') return 0
      return roots.indexOf(this.$route.path.match(/^\/(\w+)/)[1])
    },
  },

  created() {
    this.browser = browser
    this.switchRoute(this.settings.route)

    // Set global reference.
    global.PX_VM = this

    // Respond to window maximizing.
    browser.on('maximize', () => this.maximize = true)
    browser.on('unmaximize', () => this.maximize = false)
  },

  mounted() {
    this.viewScroll = this.$neatScroll(this.$refs.view)

    // Respond to resizing.
    addEventListener('resize', () => {
      this.height = window.innerHeight - 48
      this.width = window.innerWidth - 64
    }, {passive: true})

    // Save settings, accounts and error log before unload.
    addEventListener('beforeunload', () => {
      this.$store.commit('setSettings', {
        route: this.$route.path,
        language: this.$i18n.locale,
        scroll_speed: this.$neatScroll.config.speed,
        scroll_smooth: this.$neatScroll.config.smooth,
      })
      localStorage.setItem('settings', JSON.stringify(this.settings))
      localStorage.setItem('accounts', JSON.stringify(this.$store.state.accounts))
      if (errorLog.length > 0) {
        const isoString = new Date().toISOString()
        fs.writeFileSync(
          path.join(__dirname, `logs/${isoString}.log`),
          JSON.stringify(errorLog, null, 2)
        )
      }
    })
  },

  methods: {
    toggleMaximize() {
      if (browser.isMaximized()) {
        browser.unmaximize()
      } else {
        browser.maximize()
      }
    },
    updateScrollBar(switching) {
      const view = this.$refs.view
      this.switching = switching
      // Preserve current scroll style.
      if (view.scrollHeight > view.offsetHeight) {
        this.scrollBarStyle = 'auto'
      } else {
        this.scrollBarStyle = 'hidden'
      }
    },
    switchRoute(route) {
      if (this.loading) return
      if (!route) route = ''
      let nextRoute
      if (route.startsWith('/')) {
        // Using absolute path.
        nextRoute = route
      } else {
        // Using relative path, with '../' to be resolved.
        const back = (route + '/').match(/^(\.\.\/)*/)[0].length / 3
        nextRoute = `${
          this.$route.path.match(new RegExp(`^(.+)(\\/\\w+){${back}}$`))[1]
        }/${(route + '/').slice(back * 3)}`.slice(0, -1)
      }
      if (!routes.includes(nextRoute.slice(1))) {
        // Next route not found, redirect.
        if (!routes.includes(this.$route.name)) {
          // Current route not found, redirect.
          nextRoute = defaultSettings.route
        } else {
          // Current route found, no action.
          return
        }
      }
      // Determine page transition direction.
      const nextRootIndex = roots.indexOf(nextRoute.match(/^\/(\w+)/)[1])
      if (this.currentRootIndex === nextRootIndex) {
        this.leaveDirection = this.enterDirection = 'none'
      } else if (this.currentRootIndex > nextRootIndex) {
        this.leaveDirection = 'bottom'
        this.enterDirection = 'top'
      } else {
        this.leaveDirection = 'top'
        this.enterDirection = 'bottom'
      }
      this.$router.push(nextRoute)
    },
  }
}