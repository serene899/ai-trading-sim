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
    <nav class="nav">
      <RouterLink to="/dashboard">总览</RouterLink>
      <RouterLink to="/market">行情交易</RouterLink>
      <RouterLink to="/orders">订单记录</RouterLink>
    </nav>
    <div class="spacer" />
    <div class="status">
      <span class="dot" :class="{ ok: connected }" />
      {{ connected ? `本地版 · v${backendVersion}` : '未就绪' }}
    </div>
  </div>
  <RouterView />
</template>
