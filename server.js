import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { randomUUID } from 'crypto'

const app = express()
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}))
app.use(express.json({ limit: '10mb' }))

const PORT = process.env.PORT || 3000

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ShortsMaker Render Server' })
})

// Главный роут — рендер видео
app.post('/render', async (req, res) => {
  const { scenes } = req.body

  if (!scenes || !Array.isArray(scenes) || scenes.length === 0) {
    return res.status(400).json({ error: 'No scenes provided' })
  }

  const jobId = randomUUID()
  const workDir = path.join(os.tmpdir(), jobId)
  fs.mkdirSync(workDir, { recursive: true })

  console.log(`[${jobId}] Starting render with ${scenes.length} scenes`)

  try {
    // Шаг 1: скачиваем картинки и аудио
    const scenePaths = []

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i]
      console.log(`[${jobId}] Downloading scene ${i + 1}/${scenes.length}`)

      // Картинка
      const imgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(scene.image_prompt)}?width=1080&height=1920&nologo=true&model=flux`
      const imgRes = await fetch(imgUrl)
      const imgBuf = Buffer.from(await imgRes.arrayBuffer())
      const imgPath = path.join(workDir, `img_${i}.jpg`)
      fs.writeFileSync(imgPath, imgBuf)

      // Аудио (Google Translate TTS с разбивкой по чанкам)
      const audioPath = path.join(workDir, `audio_${i}.mp3`)
      await downloadAudio(scene.voiceover, audioPath)

      scenePaths.push({ imgPath, audioPath })
    }

    // Шаг 2: создаём MP4 для каждой сцены
    const sceneVideos = []
    for (let i = 0; i < scenePaths.length; i++) {
      const { imgPath, audioPath } = scenePaths[i]
      const videoPath = path.join(workDir, `scene_${i}.mp4`)
      console.log(`[${jobId}] Encoding scene ${i + 1}`)

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(imgPath)
          .inputOptions(['-loop 1'])
          .input(audioPath)
         .outputOptions([
  '-c:v libx264',
  '-preset veryfast',
  '-crf 28',
  '-pix_fmt yuv420p',
  '-shortest',
  '-vf', 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280'
])
          .save(videoPath)
          .on('end', resolve)
          .on('error', reject)
      })

      sceneVideos.push(videoPath)
    }

    // Шаг 3: склеиваем все сцены в одно видео
    console.log(`[${jobId}] Merging scenes`)
    const listPath = path.join(workDir, 'list.txt')
    fs.writeFileSync(
      listPath,
      sceneVideos.map(p => `file '${p}'`).join('\n')
    )

    const outputPath = path.join(workDir, 'output.mp4')
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy'])
        .save(outputPath)
        .on('end', resolve)
        .on('error', reject)
    })

    console.log(`[${jobId}] Done! Sending file`)

    // Шаг 4: отдаём файл
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Content-Disposition', `attachment; filename="shorts_${jobId}.mp4"`)

    const stream = fs.createReadStream(outputPath)
    stream.pipe(res)

    stream.on('end', () => {
      // Чистим временные файлы через 5 сек
      setTimeout(() => {
        try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
      }, 5000)
    })

  } catch (error) {
    console.error(`[${jobId}] Error:`, error)
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch {}
    res.status(500).json({ error: String(error) })
  }
})

// Функция скачивания аудио через Google TTS с разбивкой на чанки
async function downloadAudio(text, outputPath) {
  const maxLen = 190
  const chunks = []
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text]
  let current = ''

  for (const sentence of sentences) {
    const s = sentence.trim()
    if (!s) continue
    if (s.length > maxLen) {
      if (current) { chunks.push(current.trim()); current = '' }
      const words = s.split(' ')
      let temp = ''
      for (const word of words) {
        if ((temp + ' ' + word).length < maxLen) {
          temp += (temp ? ' ' : '') + word
        } else {
          if (temp) chunks.push(temp.trim())
          temp = word
        }
      }
      if (temp) chunks.push(temp.trim())
    } else if ((current + ' ' + s).length < maxLen) {
      current += (current ? ' ' : '') + s
    } else {
      if (current) chunks.push(current.trim())
      current = s
    }
  }
  if (current) chunks.push(current.trim())

  const buffers = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(chunk)}&tl=ru&client=tw-ob&idx=${i}&total=${chunks.length}&textlen=${chunk.length}`
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://translate.google.com/',
      },
    })
    if (!res.ok) throw new Error(`TTS failed: ${res.status}`)
    buffers.push(Buffer.from(await res.arrayBuffer()))
  }

  fs.writeFileSync(outputPath, Buffer.concat(buffers))
}

app.listen(PORT, () => {
  console.log(`Render server listening on port ${PORT}`)
})
