<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import api from '@/api'

const connected = ref(false)
const backendVersion = ref('')

async function probe() {
  try {
    const h: any = await api.health()
    connected.value = true
    backendVersion.value = h?.version || ''
  } catch {
    connected.value = false
  }
}

onMounted(() => {
  probe()
  setInterval(probe, 15000)
})
</script>

<template>
  <div class="topbar">
    <div class="brand">
      <span style="font-size:18px">◎</span>
      <span>AI 交易 · 模拟</span>
    </div>
    <div class="spacer" />
    <div class="status">
      <span class="dot" :class="{ ok: connected }" />
      {{ connected ? `本地版 · v${backendVersion}` : '未就绪' }}
    </div>
  </div>
  <RouterView />
  <nav class="tabbar" aria-label="主导航">
    <RouterLink to="/dashboard">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
      </svg>
      <span>总览</span>
    </RouterLink>
    <RouterLink to="/market">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <path d="M7 4v3M7 15v5M4.5 7h5M4.5 15h5" />
        <rect x="5.2" y="7" width="3.6" height="8" rx="1" />
        <path d="M17 3v2M17 13v8M14.5 5h5M14.5 13h5" />
        <rect x="15.2" y="5" width="3.6" height="8" rx="1" />
      </svg>
      <span>行情交易</span>
    </RouterLink>
    <RouterLink to="/orders">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <path d="M8.5 6h11M8.5 12h11M8.5 18h11" />
        <circle cx="4" cy="6" r="0.6" fill="currentColor" />
        <circle cx="4" cy="12" r="0.6" fill="currentColor" />
        <circle cx="4" cy="18" r="0.6" fill="currentColor" />
      </svg>
      <span>订单记录</span>
    </RouterLink>
  </nav>
</template>
