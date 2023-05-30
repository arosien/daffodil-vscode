/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import org.apache.daffodil.tdml.TDML

import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import scala.collection.mutable.HashSet
import scala.xml.Elem
import scala.xml.XML
import java.nio.charset.StandardCharsets

class TDMLSuite extends munit.FunSuite {
  val basePath = Paths.get("./server/core/").toAbsolutePath()
  val basePathStr = "server/core/"
  val infosetPath = Paths.get("./server/core/src/test/data/emptyInfoset.xml").toAbsolutePath()
  val schemaPath = Paths.get("./server/core/src/test/data/emptySchema.xml").toAbsolutePath()
  val dataPath = Paths.get("./server/core/src/test/data/emptyData.xml").toAbsolutePath()
  val notInfosetPath = Paths.get("./server/core/src/test/data/notInfoset.xml").toAbsolutePath()
  val tdmlName = "TestTDMLName"
  val tdmlDescription = "Test TDML Description"
  val tdmlPath = Paths.get("./testTDML.tdml")
  val expectedNSHashSet = HashSet[String](
    "http://www.ibm.com/xmlns/dfdl/testData",
    "urn:ogf:dfdl:2013:imp:daffodil.apache.org:2018:ext",
    "http://www.ogf.org/dfdl/dfdl-1.0/",
    "http://www.ogf.org/dfdl/dfdl-1.0/extensions",
    "http://www.w3.org/2001/XMLSchema",
    "urn:ogf:dfdl:2013:imp:daffodil.apache.org:2018:int"
  )
  val tdmlSingleTestCase = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns1:testSuite xmlns:ns1="http://www.ibm.com/xmlns/dfdl/testData" xmlns:ns2="urn:ogf:dfdl:2013:imp:daffodil.apache.org:2018:ext" xmlns:ns3="http://www.ogf.org/dfdl/dfdl-1.0/" xmlns:ns4="http://www.ogf.org/dfdl/dfdl-1.0/extensions" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:ns6="urn:ogf:dfdl:2013:imp:daffodil.apache.org:2018:int" suiteName="TestTDMLName" defaultRoundTrip="onePass">
    <ns1:parserTestCase name="TestTDMLName" root="file" model="server/core/src/test/data/emptySchema.xml" roundTrip="onePass" description="Test TDML Description">
        <ns1:document>
            <ns1:documentPart type="file">server/core/src/test/data/emptyData.xml</ns1:documentPart>
        </ns1:document>
        <ns1:infoset>
            <ns1:dfdlInfoset type="file">server/core/src/test/data/emptyInfoset.xml</ns1:dfdlInfoset>
        </ns1:infoset>
    </ns1:parserTestCase>
</ns1:testSuite>"""
  val tdmlDoubleTestCase = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns1:testSuite xmlns:ns1="http://www.ibm.com/xmlns/dfdl/testData" xmlns:ns2="urn:ogf:dfdl:2013:imp:daffodil.apache.org:2018:ext" xmlns:ns3="http://www.ogf.org/dfdl/dfdl-1.0/" xmlns:ns4="http://www.ogf.org/dfdl/dfdl-1.0/extensions" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:ns6="urn:ogf:dfdl:2013:imp:daffodil.apache.org:2018:int" suiteName="TestTDMLName" defaultRoundTrip="onePass">
    <ns1:parserTestCase name="TestTDMLName" root="file" model="server/core/src/test/data/emptySchema.xml" roundTrip="onePass" description="Test TDML Description">
        <ns1:document>
            <ns1:documentPart type="file">server/core/src/test/data/emptyData.xml</ns1:documentPart>
        </ns1:document>
        <ns1:infoset>
            <ns1:dfdlInfoset type="file">server/core/src/test/data/emptyInfoset.xml</ns1:dfdlInfoset>
        </ns1:infoset>
    </ns1:parserTestCase>
    <ns1:parserTestCase name="TestTDMLName" root="file" model="server/core/src/test/data/emptySchema.xml" roundTrip="onePass" description="Test TDML Description">
        <ns1:document>
            <ns1:documentPart type="file">server/core/src/test/data/emptyData.xml</ns1:documentPart>
        </ns1:document>
        <ns1:infoset>
            <ns1:dfdlInfoset type="file">server/core/src/test/data/emptyInfoset.xml</ns1:dfdlInfoset>
        </ns1:infoset>
    </ns1:parserTestCase>
</ns1:testSuite>"""
  val tdmlSingleTestCaseXml = XML.loadString(tdmlSingleTestCase)
  val tdmlDoubleTestCaseXml = XML.loadString(tdmlDoubleTestCase)

  override def afterEach(context: AfterEach): Unit = { val _ = tdmlPath.toFile.delete() }

  test("Test Generate") {
    generate(infosetPath, schemaPath, dataPath, tdmlName, tdmlDescription, tdmlPath.toString())

    val content = readString(tdmlPath)
    val contentXml = XML.loadString(content)

    // Validate the namespaces as well. If they ever get placed out of order, this test can act as a canary.
    assertEquals(getNamespaces(contentXml), expectedNSHashSet)
    assertEquals(contentXml, tdmlSingleTestCaseXml)
  }

  test(name = "Negative Generate") {
    generate(notInfosetPath, schemaPath, dataPath, tdmlName, tdmlDescription, tdmlPath.toString())

    val content = readString(tdmlPath)
    val contentXml = XML.loadString(content)

    // Validate that this does fail if the input data is bad, but namespaces should still be okay
    assertEquals(getNamespaces(contentXml), expectedNSHashSet)
    assertNotEquals(contentXml, tdmlSingleTestCaseXml)
  }

  test("Test Execute") {
    println(tdmlPath)
    println(tdmlPath.getParent())
    println(tdmlPath.getFileName())
    println(tdmlPath.toUri.toASCIIString())
    generate(infosetPath, schemaPath, dataPath, tdmlName, tdmlDescription, tdmlPath.toString())
    val Some(TDML.Execute(executedSchema, executedData)) = TDML.execute(tdmlName, tdmlPath)

    assertEquals(
      Option((executedSchema.normalize.toAbsolutePath(), executedData.normalize.toAbsolutePath())),
      Option[(Path, Path)]((schemaPath.normalize(), dataPath.normalize()))
    )
  }

  test("Test convertToRelativePath") {
    val relativePath = convertToRelativePath(basePath, tdmlPath.toString())

    assertEquals(relativePath, basePathStr)
  }

  // Convert an absolute path into a path relative to the current working directory
  //
  // path: Absolute path to convert into a relative path
  // tdmlPath: Absolute path to the TDML file to make
  //
  // Returns the relative path. Note that this path is given as a string.
  def convertToRelativePath(path: Path, tdmlPath: String): String = {
    // Get the absolute path of the workspace directory
    // The path is the path to a file. To get the proper relative path, we need
    //   to start at the parent of the file.
    var workingDir = Paths.get(tdmlPath).toAbsolutePath().getParent()
    var prefix = ""

    // This is used to back up the path tree in order to find the first common ancestor of both paths
    // If a user wants to use a file not in or under the current working directory, this will be required to
    //   produce the expected output.
    // A possible use case of this is where a user has a data folder and a schema folder that are siblings.
    while (!path.startsWith(workingDir) && Paths.get(workingDir.toString()).getParent() != null) {
      workingDir = Paths.get(workingDir.toString()).getParent()
      // Need to add the dots to represent that we've gone back a step up the path
      prefix += ".." + File.separator
    }

    prefix + new File(workingDir.toString())
      .toURI()
      .relativize(new File(path.toString()).toURI())
      .getPath()
      .toString()
  }

  // Generate a new TDML file.
  // Paths given to this function should be absolute as they will be converted to relative paths
  //
  // infosetPath:     Path to the infoset
  // schemaPath:      Path to the DFDL Schema
  // dataPath:        Path to the data file
  // tdmlName:        Name of the DFDL operation
  // tdmlDescription: Description for the DFDL operation
  // tdmlPath:        Path to the TDML file
  def generate(
      infosetPath: Path,
      schemaPath: Path,
      dataPath: Path,
      tdmlName: String,
      tdmlDescription: String,
      tdmlPath: String
  ): Unit =
    generate(
      convertToRelativePath(infosetPath, tdmlPath),
      convertToRelativePath(schemaPath, tdmlPath),
      convertToRelativePath(dataPath, tdmlPath),
      tdmlName,
      tdmlDescription,
      tdmlPath
    )

  // Generate a new TDML file.
  // There is a suiteName attribute in the root element (TestSuite) of the document. This is set to $tdmlName
  // Paths given to this function should be relative as it should be expected for the TDML files to be shared on the mailing list
  //
  // infosetPath:     Path to the infoset
  // schemaPath:      Path to the DFDL Schema
  // dataPath:        Path to the data file
  // tdmlName:        Name of the DFDL operation
  // tdmlDescription: Description for the DFDL operation
  // tdmlPath:        Path to the TDML file
  //
  // There is a suiteName attribute in the root element of the document. This is set to tdmlName
  def generate(
      infosetPath: String,
      schemaPath: String,
      dataPath: String,
      tdmlName: String,
      tdmlDescription: String,
      tdmlPath: String
  ): Unit = {
    val s =
      s"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
         |<ns1:testSuite xmlns:ns1="http://www.ibm.com/xmlns/dfdl/testData" xmlns:ns2="urn:ogf:dfdl:2013:imp:daffodil.apache.org:2018:ext" xmlns:ns3="http://www.ogf.org/dfdl/dfdl-1.0/" xmlns:ns4="http://www.ogf.org/dfdl/dfdl-1.0/extensions" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:dafint="urn:ogf:dfdl:2013:imp:daffodil.apache.org:2018:int" suiteName="${tdmlName}" defaultRoundTrip="onePass">
        |    <ns1:parserTestCase name="${tdmlName}" root="file" model="${schemaPath}" roundTrip="onePass" description="${tdmlDescription}">
        |        <ns1:document>
        |            <ns1:documentPart type="file">${dataPath}</ns1:documentPart>
        |        </ns1:document>
        |        <ns1:infoset>
        |            <ns1:dfdlInfoset type="file">${infosetPath}</ns1:dfdlInfoset>
        |        </ns1:infoset>
        |    </ns1:parserTestCase>
        |</ns1:testSuite>""".stripMargin
    val file = new File(tdmlPath)
    val bw = new java.io.BufferedWriter(new java.io.FileWriter(file))
    bw.write(s)
    bw.close()
  }

  def getNamespaces(root: Elem): HashSet[String] = {
    val contentSet = HashSet[String]()
    val namespaces = root.scope.toString().split(" ")
    // The list contains an empty element. We are filtering for namespaces, which will always contain an '='
    namespaces.filter(_.contains("=")).foreach { ns =>
      val nsValue = ns.split("=")(1)
      contentSet += (nsValue.substring(1, nsValue.length() - 1))
    }

    contentSet
  }

  // Files.readString doesn't exist until Java 11. This should work for all versions of Java.
  def readString(path: Path): String = {
    val bytes = Files.readAllBytes(path)
    new String(bytes, StandardCharsets.UTF_8)
  }
}
