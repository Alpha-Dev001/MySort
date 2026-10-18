import { describe, expect, it } from 'vitest'
import { classifyFileName, categoryFolderName, normalizeExtension, candidateSuffixes } from '../src/engine/classify'
import type { Classification } from '../src/engine/classify'

describe('classify', () => {
  describe('normalizeExtension', () => {
    it('lowercases and strips leading dot', () => {
      expect(normalizeExtension('PDF')).toEqual({ ok: true, ext: 'pdf' })
      expect(normalizeExtension('.DOCX')).toEqual({ ok: true, ext: 'docx' })
      expect(normalizeExtension('tar.gz')).toEqual({ ok: true, ext: 'tar.gz' })
    })
  })

  describe('candidateSuffixes', () => {
    it('returns all suffixes of a compound name', () => {
      expect(candidateSuffixes('backup.tar.gz')).toEqual(['tar.gz', 'gz'])
      expect(candidateSuffixes('report.pdf')).toEqual(['pdf'])
      expect(candidateSuffixes('.hidden')).toEqual([])
    })
  })

  describe('categoryFolderName', () => {
    it('returns the human category folder name', () => {
      expect(categoryFolderName('images')).toBe('Images')
      expect(categoryFolderName('videos')).toBe('Videos')
      expect(categoryFolderName('documents')).toBe('Documents')
      expect(categoryFolderName('audio')).toBe('Audio')
      expect(categoryFolderName('archives')).toBe('Archives')
      expect(categoryFolderName('other')).toBe('Other')
    })
  })

  describe('classifyFileName', () => {
    const c = (name: string): Classification => classifyFileName(name)

    it('classifies common image extensions', () => {
      expect(c('photo.png').category).toBe('images')
      expect(c('img.JPG').category).toBe('images')
      expect(c('photo.jpeg').category).toBe('images')
      expect(c('anim.gif').category).toBe('images')
      expect(c('pic.webp').category).toBe('images')
      expect(c('bmp.bmp').category).toBe('images')
    })

    it('classifies video extensions', () => {
      expect(c('movie.mp4').category).toBe('videos')
      expect(c('clip.mov').category).toBe('videos')
      expect(c('film.mkv').category).toBe('videos')
      expect(c('clip.avi').category).toBe('videos')
      expect(c('rec.webm').category).toBe('videos')
    })

    it('classifies document extensions', () => {
      expect(c('doc.docx').category).toBe('documents')
      expect(c('doc.pdf').category).toBe('documents')
      expect(c('sheet.xlsx').category).toBe('documents')
      expect(c('notes.txt').category).toBe('documents')
      expect(c('memo.md').category).toBe('documents')
      expect(c('slide.pptx').category).toBe('documents')
    })

    it('classifies audio extensions', () => {
      expect(c('song.mp3').category).toBe('audio')
      expect(c('track.flac').category).toBe('audio')
      expect(c('wav.wav').category).toBe('audio')
      expect(c('aac.aac').category).toBe('audio')
    })

    it('classifies archive extensions', () => {
      expect(c('backup.zip').category).toBe('archives')
      expect(c('pkg.tar.gz').category).toBe('archives')
      expect(c('stuff.7z').category).toBe('archives')
      expect(c('bundle.rar').category).toBe('archives')
    })

    it('classifies everything else as other', () => {
      expect(c('setup.exe').category).toBe('other')
      expect(c('script.py').category).toBe('other')
      expect(c('data.bin').category).toBe('other')
      expect(c('archive.xyzzy').category).toBe('other')
    })

    it('returns null category for files with no extension', () => {
      // No extension means nothing to classify on. resolveRule turns this into
      // a `no_action` and leaves the file exactly where it is, rather than
      // guessing a category out of nothing.
      expect(c('README').category).toBeNull()
      expect(c('noext').category).toBeNull()
      expect(c('Makefile').category).toBeNull()
      expect(c('LICENSE').matchedSuffix).toBeNull()
    })

    it('is case-insensitive', () => {
      expect(c('PHOTO.PNG').category).toBe('images')
    })
  })
})
