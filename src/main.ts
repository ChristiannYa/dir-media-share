import { createApp } from 'vue'
import Root from './Root.vue'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/ring.css'
import { trackScreenHz } from './utils/screenRate'

// previews pick their speed to match the screen's refresh rate
trackScreenHz()

createApp(Root).mount('#app')
