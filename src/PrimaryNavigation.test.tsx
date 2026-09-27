import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PrimaryNavigation } from './PrimaryNavigation'

describe('PrimaryNavigation', () => {
  it('includes Media Library and renders its active state', () => {
    const markup = renderToStaticMarkup(
      <PrimaryNavigation currentView="media" onViewChange={() => undefined}/>,
    )

    expect(markup).toContain('Media Library')
    expect(markup).toContain('<button class="active">Media Library</button>')
    expect(markup).toContain('Timeline')
    expect(markup).toContain('Life Map')
  })
})
