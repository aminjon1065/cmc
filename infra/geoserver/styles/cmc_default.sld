<?xml version="1.0" encoding="UTF-8"?>
<!--
  CMC default GIS style (ADR-0079, Phase 2).
  One rule with three symbolizers — GeoServer applies each to the matching
  geometry, so the same style renders points, lines AND polygons cleanly
  (replaces GeoServer's plain default that looked "strange").
-->
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>cmc_default</Name>
    <UserStyle>
      <Title>CMC default</Title>
      <Abstract>Points, lines and polygons in the CMC accent colour.</Abstract>
      <FeatureTypeStyle>
        <Rule>
          <Title>CMC feature</Title>
          <PolygonSymbolizer>
            <Fill>
              <CssParameter name="fill">#2f6fe0</CssParameter>
              <CssParameter name="fill-opacity">0.22</CssParameter>
            </Fill>
            <Stroke>
              <CssParameter name="stroke">#2f6fe0</CssParameter>
              <CssParameter name="stroke-width">1.6</CssParameter>
            </Stroke>
          </PolygonSymbolizer>
          <LineSymbolizer>
            <Stroke>
              <CssParameter name="stroke">#2f6fe0</CssParameter>
              <CssParameter name="stroke-width">2.2</CssParameter>
            </Stroke>
          </LineSymbolizer>
          <PointSymbolizer>
            <Graphic>
              <Mark>
                <WellKnownName>circle</WellKnownName>
                <Fill><CssParameter name="fill">#2f6fe0</CssParameter></Fill>
                <Stroke>
                  <CssParameter name="stroke">#ffffff</CssParameter>
                  <CssParameter name="stroke-width">1.6</CssParameter>
                </Stroke>
              </Mark>
              <Size>12</Size>
            </Graphic>
          </PointSymbolizer>
        </Rule>
      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
